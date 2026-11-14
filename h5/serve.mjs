#!/usr/bin/env node
/**
 * AgentCenter H5 本地服务（零依赖）
 *
 * 职责：
 *   1. 以 http://127.0.0.1:<port>/ 提供 H5 静态页面（可安装为 PWA）
 *   2. 暴露 /api/health 与 /api/summary，供 H5 读取真实扫描结果
 *
 * 安全边界：
 *   - 只绑定 127.0.0.1，不对局域网开放
 *   - 只读：不写业务数据，不接触任何 Agent 源目录
 *   - 无目录穿越：请求路径规范化后必须落在 h5 目录内
 *
 * 用法：
 *   node serve.mjs                # 默认 7788
 *   node serve.mjs --port 8899
 *   set AC_PORT=8899 && node serve.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// 能力探测：旧版 Node 没有 node:zlib 的 zstd，这里只读标志，不做解压
import { ZSTD_AVAILABLE, zstdUnavailableReason } from '../core/util.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const APP_ROOT = path.resolve(__dirname, '..');
/* 数据目录：默认 <app>/data（仓库里直接跑 CLI 时就是 AgentCenter/data）。
   npm 包里 app/ 位于 node_modules 下，不能往那儿写，所以插件托管时会传
   options.dataDir（或 AC_DATA_DIR），指向用户目录（默认 ~/.agentcenter）。 */
let DATA_DIR = process.env.AC_DATA_DIR ? path.resolve(process.env.AC_DATA_DIR) : path.join(APP_ROOT, 'data');
// 实际监听端口（系统分配时与配置值不同），/api/health 会回给页面
let DATA_PORT = Number(process.env.AC_PORT) || 7788;
const dataFile = () => path.join(DATA_DIR, 'summary.json');
const scansFile = () => path.join(DATA_DIR, 'scans.json');
const overridesFile = () => path.join(DATA_DIR, 'overrides.json');
const indexFile = () => path.join(DATA_DIR, 'index.json');

const argv = process.argv.slice(2);
const portArg = argv.indexOf('--port');
const PORT = Number(
  (portArg > -1 && argv[portArg + 1]) || process.env.AC_PORT || 7788
);
const HOST = '127.0.0.1';
const START = Date.now();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

function send(res, code, body, headers) {
  res.writeHead(code, Object.assign({ 'Cache-Control': 'no-store' }, headers || {}));
  res.end(body);
}

function json(res, code, obj) {
  send(res, code, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const LOG_DIR = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.agentcenter'), 'AgentCenter');
const LOG_FILE = path.join(LOG_DIR, 'h5.log');

// 落盘日志：控制台窗口被关闭后仍可回溯启动失败原因；写失败绝不影响服务
function fileLog(msg) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
  } catch (_) {}
}

function log(...a) {
  const line = a.map((x) => (typeof x === 'string' ? x : String(x))).join(' ');
  console.log(`[${stamp()}]`, ...a);
  fileLog(line);
}

async function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel === '/' || rel === '') rel = '/index.html';

  const target = path.normalize(path.join(ROOT, rel));
  if (!target.startsWith(ROOT)) return send(res, 403, 'Forbidden');

  try {
    const st = await fsp.stat(target);
    if (st.isDirectory()) return serveStatic(req, res, path.join(rel, 'index.html'));
    const ext = path.extname(target).toLowerCase();
    const buf = await fsp.readFile(target);
    send(res, 200, buf, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': buf.length,
      // 开发期不缓存 HTML / SW，避免改完看不到
      'Cache-Control': ext === '.html' || target.endsWith('sw.js') ? 'no-store' : 'public, max-age=300'
    });
  } catch (e) {
    if (e.code === 'ENOENT') {
      // 前端为 hash 路由，任何未知路径回落到 index.html
      try {
        const buf = await fsp.readFile(path.join(ROOT, 'index.html'));
        return send(res, 200, buf, { 'Content-Type': MIME['.html'] });
      } catch (_) {
        return send(res, 404, 'Not Found');
      }
    }
    log('静态资源读取失败:', e.message);
    send(res, 500, 'Internal Error');
  }
}

async function apiHealth(res) {
  let lastScan = null;
  let generatedAt = null;
  try {
    const st = await fsp.stat(dataFile());
    lastScan = new Date(st.mtimeMs).toTimeString().slice(0, 5);
    try {
      const j = JSON.parse(await fsp.readFile(dataFile(), 'utf8'));
      generatedAt = (j.data || j).generatedAt || null;
    } catch (_) {}
  } catch (_) {}
  json(res, 200, {
    ok: true,
    name: 'agentcenter-h5',
    version: '0.2.0',
    mode: lastScan ? 'live' : 'demo',
    uptimeMs: Date.now() - START,
    port: DATA_PORT,
    lastScan,
    generatedAt,
    dataSource: lastScan ? dataFile() : null,
    dataDir: path.dirname(dataFile()),
    node: process.versions.node,
    zstd: ZSTD_AVAILABLE,
    hint: lastScan ? null : '未找到 data/summary.json，前端回退到演示数据；运行 node cli/agentcenter.mjs scan 生成索引',
    notice: ZSTD_AVAILABLE ? null : zstdUnavailableReason()
  });
}

/* 读取任务对话详情：按 taskId 回放原始会话文件（只读，不写任何源目录） */
async function apiConversation(res, query) {
  const taskId = query.get('taskId') || query.get('id') || '';
  if (!taskId) return json(res, 400, { ok: false, reason: '缺少 taskId' });
  try {
    const { readConversation } = await import('../core/conversation.mjs');
    const raw = await fsp.readFile(indexFile(), 'utf8');
    const idx = JSON.parse(raw);
    const task = (idx.tasks || []).find((t) => t.taskId === taskId || t.id === taskId);
    if (!task) return json(res, 404, { ok: false, reason: '索引中找不到该任务', taskId });
    const limit = Math.min(Number(query.get('limit')) || 300, 1000);
    const conv = await readConversation(task, { limit });
    if (!conv.ok) return json(res, 404, { ok: false, reason: conv.reason, taskId, sourceFile: conv.sourceFile });
    json(res, 200, Object.assign({ ok: true, taskId }, conv));
  } catch (e) {
    log('读取对话失败:', e.message);
    json(res, 500, { ok: false, reason: '读取对话失败', detail: e.message, taskId });
  }
}

/* ============ 会话内容深搜（按需） ============
   任务列表的普通搜索只匹配标题/项目/Agent；这里是「搜会话内容」的按需通道：
   先按 status/agent/日期把候选收窄，再逐条读会话（并发 4），命中即收集片段。
   逐条读原始会话文件很重，所以：候选上限、总时长上限、命中数上限三处都卡住。 */
const DEEP_SEARCH_CONCURRENCY = 8;
const DEEP_SEARCH_MAX_CANDIDATES = 1200;
const DEEP_SEARCH_BUDGET_MS = 25000;

/**
 * 会话内容深搜（按需）。
 *
 * 任务列表的普通搜索只匹配标题/项目/Agent；这条通道才进会话正文，并可包含「思考」。
 * 实现是「按任务分片索引 + 懒构建」：每个任务的正文行缓存在 <dataDir>/search/<taskId>.txt，
 * 源文件没变就直接复用。所以第一次搜会慢一点（要抽一次正文），之后是毫秒级。
 * 扫描本身完全不参与，不会拖慢日常扫描。
 */
async function apiSearchContent(res, query) {
  const q = String(query.get('q') || '').trim();
  if (q.length < 2) return json(res, 400, { ok: false, reason: '关键词至少 2 个字符' });
  const scope = String(query.get('scope') || 'content');
  const includeThink = scope === 'think';
  const includeTool = query.get('tool') === '1';
  const maxHits = Math.min(Number(query.get('hits')) || 5, 20);
  const limit = Math.min(Number(query.get('limit')) || 60, 200);

  try {
    const { searchTasks } = await import('../core/search-index.mjs');
    const raw = await fsp.readFile(indexFile(), 'utf8');
    const idx = JSON.parse(raw);
    const from = String(query.get('from') || '');
    const to = String(query.get('to') || '');
    const status = String(query.get('status') || 'all');
    const agent = String(query.get('agent') || 'all');

    const candidates = (idx.tasks || []).filter((t) => {
      if (status !== 'all' && t.status !== status) return false;
      if (agent !== 'all' && t.agentId !== agent) return false;
      const s = String(t.startedAt || '').slice(0, 10);
      const e = String(t.endedAt || s).slice(0, 10);
      if (from && e && e < from) return false;
      if (to && s && s > to) return false;
      return true;
    });

    const found = await searchTasks(DATA_DIR, candidates, q.toLowerCase(), {
      includeThink, includeTool, maxHits, limit,
      budgetMs: Number(query.get('budget')) || 90000,
    });

    const items = found.results.map((row) => ({
      taskId: row.task.taskId || row.task.id || '',
      title: row.task.title || '',
      agent: row.task.agentName || row.task.agent || '',
      agentId: row.task.agentId || '',
      project: row.task.project || '',
      dir: row.task.dir || '',
      status: row.task.status || '',
      start: row.task.start || '',
      end: row.task.end || '',
      total: row.total,
      hits: row.hits,
    }));

    json(res, 200, {
      ok: true, q, scope, includeTool,
      candidates: candidates.length,
      scanned: found.scanned,
      truncated: found.truncated,
      ms: found.ms,
      count: items.length,
      items,
    });
  } catch (e) {
    log('会话深搜失败:', e.message);
    json(res, 500, { ok: false, reason: '搜索失败', detail: e.message });
  }
}

async function apiTaskDone(req, res, query) {
  const taskId = query.get('taskId') || query.get('id') || '';
  const undo = query.get('undo') === '1';
  if (!taskId) return json(res, 400, { ok: false, reason: '缺少 taskId' });
  try {
    const { setTaskDone, refreshSummaryFromIndex, readOverrides } = await import('../core/scan.mjs');
    const dataDir = DATA_DIR;
    // 先确认任务存在于索引，避免写入无效 id
    const idx = JSON.parse(await fsp.readFile(path.join(dataDir, 'index.json'), 'utf8'));
    const task = (idx.tasks || []).find((t) => t.taskId === taskId || t.id === taskId);
    if (!task) return json(res, 404, { ok: false, reason: '索引中找不到该任务', taskId });
    const r = setTaskDone(taskId, { dataDir, done: !undo });
    if (!r.ok) return json(res, 400, { ok: false, reason: r.reason });
    const refreshed = refreshSummaryFromIndex(dataDir);
    log('人工标记完成:', taskId, undo ? '(撤销)' : '');
    json(res, 200, {
      ok: true, taskId, done: !undo,
      overrides: readOverrides(dataDir).tasks,
      applied: refreshed.applied || 0,
      summary: refreshed.summary || null,
      note: '仅记录在本机索引，不修改 Agent 原始会话记录'
    });
  } catch (e) {
    log('标记完成失败:', e.message);
    json(res, 500, { ok: false, reason: '标记失败', detail: e.message, taskId });
  }
}

/* 扫描历史：读 data/scans.json（每轮扫描的真实记录），供「扫描调度」页展示 */
async function apiScans(res, query) {
  const limit = Math.min(Number(query.get('limit')) || 50, 200);
  try {
    const raw = await fsp.readFile(scansFile(), 'utf8');
    const j = JSON.parse(raw);
    const scans = Array.isArray(j.scans) ? j.scans : [];
    let overrides = 0;
    try {
      const ov = JSON.parse(await fsp.readFile(overridesFile(), 'utf8'));
      overrides = Object.keys(ov.tasks || {}).length;
    } catch (_) {}
    json(res, 200, {
      ok: true,
      scans: scans.slice(0, limit),
      total: scans.length,
      overrides,
      note: '记录来自 data/scans.json；每轮扫描写入一条，保留最近 50 条'
    });
  } catch (e) {
    if (e.code === 'ENOENT') {
      return json(res, 200, { ok: true, scans: [], total: 0, overrides: 0, note: '尚无扫描记录：先运行 node cli/agentcenter.mjs scan' });
    }
    json(res, 500, { ok: false, reason: '读取扫描历史失败', detail: e.message });
  }
}

/* 日报：列表 / 关键字搜索 / 日期过滤；mode=content 时返回单日原文；mode=generate 时按索引即时生成落盘 */
async function apiReports(res, query) {
  const mode = query.get('mode') || 'list';
  const date = query.get('date') || '';
  const q = query.get('q') || '';
  const from = query.get('from') || '';
  const to = query.get('to') || '';
  const limit = Math.min(Number(query.get('limit')) || 30, 200);
  try {
    const rpt = await import('../core/report.mjs');
    const dataDir = DATA_DIR;

    if (mode === 'content') {
      if (!date) return json(res, 400, { ok: false, reason: '缺少 date' });
      const md = rpt.readReport(dataDir, date);
      if (md === null) return json(res, 404, { ok: false, reason: '该日期尚无日报', date });
      return json(res, 200, { ok: true, date, markdown: md, bytes: md.length });
    }

    let summary = null;
    try { summary = JSON.parse(await fsp.readFile(dataFile(), 'utf8')); } catch (_) {}

    if (mode === 'generate') {
      if (!summary) return json(res, 503, { ok: false, reason: '索引尚未生成，无法生成日报' });
      const today = (() => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); })();
      const r = rpt.writeReport(summary, dataDir, date || today);
      log('日报已生成:', r.file);
      return json(res, 200, { ok: true, date: r.date, file: r.file, bytes: r.md.length, markdown: r.md });
    }

    const items = rpt.queryReports({ dataDir, summary, q, from, to, limit });
    json(res, 200, {
      ok: true, q, from, to,
      count: items.length,
      dates: rpt.listReportDates(dataDir),
      reports: items,
      note: '日报落盘在 data/日报/YYYY-MM-DD.md；可按关键字与日期区间检索'
    });
  } catch (e) {
    log('读取日报失败:', e.message);
    json(res, 500, { ok: false, reason: '读取日报失败', detail: e.message });
  }
}

/* 配置读写：GET 返回 data/config.json；POST 按 action 更新对应字段。
   只写索引目录，绝不触碰任何 Agent 源目录。 */
async function apiGetConfig(res) {
  try {
    const { readConfig } = await import('../core/scan.mjs');
    const cfg = readConfig(DATA_DIR);
    json(res, 200, { ok: true, config: cfg });
  } catch (e) {
    json(res, 500, { ok: false, reason: '读取配置失败', detail: e.message });
  }
}

async function apiSetConfig(req, res) {
  const action = new URL(req.url, 'http://' + HOST).searchParams.get('action') || 'agent';
  try {
    const core = await import('../core/scan.mjs');
    const dataDir = DATA_DIR;
    const q = new URL(req.url, 'http://' + HOST).searchParams;

    if (action === 'agent') {
      const id = q.get('id') || '';
      const r = core.setAgentConfig(id, {
        enabled: q.get('enabled') === null ? undefined : (q.get('enabled') === '1'),
        path: q.get('path') === null ? undefined : q.get('path'),
        heartbeatMs: q.get('heartbeatMs') === null ? undefined : Number(q.get('heartbeatMs'))
      }, dataDir);
      if (!r.ok) return json(res, 400, r);
      log('配置更新:', id, q.get('enabled') === '1' ? '启用' : (q.get('enabled') === '0' ? '停用' : ''));
      return json(res, 200, { ok: true, config: r.config });
    }

    if (action === 'reset-path') {
      const r = core.resetAgentPath(q.get('id') || '', dataDir);
      return json(res, 200, { ok: true, config: r.config });
    }

    if (action === 'custom-add' || action === 'custom-remove') {
      const r = action === 'custom-add'
        ? core.upsertCustomAdapter({
            id: q.get('id') || '', name: q.get('name') || '', path: q.get('path') || '',
            family: q.get('family') || 'claude-jsonl', glob: q.get('glob') || '*.jsonl',
            enabled: true
          }, dataDir)
        : core.removeCustomAdapter(q.get('id') || '', dataDir);
      if (!r.ok) return json(res, 400, r);
      return json(res, 200, { ok: true, config: r.config });
    }

    if (action === 'scan') {
      // 只合并传入的字段，未传的保持原值
      const cur = core.readConfig(dataDir);
      const scan = { ...(cur.scan || {}) };
      const bool = (k) => { const v = q.get(k); if (v !== null) scan[k] = (v === '1'); };
      const num = (k) => { const v = q.get(k); if (v !== null && v !== '') scan[k] = Number(v); };
      const str = (k) => { const v = q.get(k); if (v !== null && v !== '') scan[k] = v; };
      num('intervalMin'); bool('intervalEnabled');
      str('dailyAt'); bool('dailyEnabled');
      str('weeklyAt'); bool('weeklyEnabled');
      bool('reportAuto'); num('windowDays');
      const r = core.writeConfig({ scan }, dataDir);
      log('调度规则更新:', JSON.stringify(scan));
      return json(res, 200, { ok: true, config: r.config });
    }

    if (action === 'probe') {
      // 只读探测：路径是否存在、匹配多少个文件；不写任何文件
      const target = q.get('path') || '';
      const globPat = q.get('glob') || '*.jsonl';
      const { expandPath, exists } = await import('../core/util.mjs');
      const abs = expandPath(target);
      const st = exists(abs);
      if (!st) return json(res, 200, { ok: true, exists: false, path: abs, files: 0 });
      let files = 0;
      try {
        const { walkFiles } = await import('../core/util.mjs');
        const list = walkFiles(abs, { maxFiles: 2000 });
        const re = new RegExp(globPat.replace(/\*\*/g, '.*').replace(/\*/g, '[^/\\\\]*').replace(/\./g, '\\.'));
        files = list.filter((f) => re.test(f.path.replace(/\\/g, '/')) || f.path.endsWith('.jsonl')).length;
      } catch (_) { files = 0; }
      return json(res, 200, { ok: true, exists: true, path: abs, files, dir: !!st.isDirectory() });
    }

    return json(res, 400, { ok: false, reason: '未知 action：' + action });
  } catch (e) {
    log('配置写入失败:', e.message);
    json(res, 500, { ok: false, reason: '写入配置失败', detail: e.message });
  }
}

async function apiSummary(res, query) {
  try {
    const raw = await fsp.readFile(dataFile(), 'utf8');
    const parsed = JSON.parse(raw);
    // 索引文件可能直接是数据对象，也可能被包了一层 {ok,data}
    const data = parsed && parsed.data ? parsed.data : parsed;
    json(res, 200, { ok: true, range: query.get('range') || 'today', data });
  } catch (e) {
    json(res, 503, {
      ok: false,
      reason: '索引尚未生成',
      detail: e.code === 'ENOENT' ? `缺少 ${dataFile()}` : e.message,
      next: '先运行 CLI: node cli/agentcenter.mjs scan'
    });
  }
}

/* 扫描触发不通过 HTTP 暴露（《展示形态与H5方案》§5.4）：
   扫描会遍历并解析 Agent 源目录，属于本机 CLI 能力；HTTP 侧只提供
   受控的人工标记入口（/api/task-done，仅写索引目录）。 */
async function apiScan(res) {
  json(res, 501, {
    ok: false,
    reason: '扫描内核尚未接入 HTTP',
    detail: '为避免浏览器触发写入，HTTP 只读；扫描请在本机执行 node cli/agentcenter.mjs scan'
  });
}

/* ============ 服务工厂 ============
   同一个实现两种用法：
   - CLI / start-h5.cmd：`node h5/serve.mjs --port 8899`
   - DSH 插件：`import { createAgentCenterServer } from './serve.mjs'`，在 Host 进程内
     直接 listen / close，不拉子进程、不开浏览器窗口（见 plugin/index.js）。
   两种用法共用上面的全部 handler，行为一致。 */
export function createAgentCenterServer(options = {}) {
  // 数据目录由调用方决定（插件传用户目录；CLI 用 app/data）
  if (typeof options.dataDir === 'string' && options.dataDir !== '') DATA_DIR = path.resolve(options.dataDir);
  // 0 表示交给系统分配（测试/截图用），负值与非法值才回落到默认端口
  const requested = Number(options.port);
  DATA_PORT = Number.isInteger(requested) && requested >= 0 ? requested : DATA_PORT;
  const port = Number.isInteger(requested) && requested >= 0 ? requested : PORT;
  const host = typeof options.host === 'string' && options.host ? options.host : HOST;
  const startedAt = Date.now();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${host}:${port}`);

    if (url.pathname === '/api/health') return apiHealth(res);
    if (url.pathname === '/api/summary') return apiSummary(res, url.searchParams);
    if (url.pathname === '/api/scan') return apiScan(res);
    if (url.pathname === '/api/scans') return apiScans(res, url.searchParams);
    if (url.pathname === '/api/conversation') return apiConversation(res, url.searchParams);
    if (url.pathname === '/api/search') return apiSearchContent(res, url.searchParams);
    if (url.pathname === '/api/reports') return apiReports(res, url.searchParams);
    if (url.pathname === '/api/config') {
      if (req.method === 'GET') return apiGetConfig(res);
      if (req.method === 'POST') return apiSetConfig(req, res);
      return json(res, 405, { ok: false, reason: '仅支持 GET / POST' });
    }
    // 写入口：人工标记完成（data/overrides.json）与配置（data/config.json），均不触碰 Agent 源目录
    if (url.pathname === '/api/task-done') {
      if (req.method !== 'POST') return json(res, 405, { ok: false, reason: '仅支持 POST' });
      return apiTaskDone(req, res, url.searchParams);
    }
    if (url.pathname.startsWith('/api/')) return json(res, 404, { ok: false, reason: 'unknown api' });

    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method Not Allowed');
    return serveStatic(req, res, url.pathname);
  });

  return {
    port,
    host,
    /** 已监听返回没有端口的 origin；未监听返回 null。 */
    url: null,
    startedAt,
    server,
    /** @returns {Promise<{url: string, port: number}>} 监听成功后的地址；失败 reject（EADDRINUSE 等）。 */
    listen() {
      return new Promise((resolve, reject) => {
        const onError = (err) => {
          server.off('listening', onListening);
          reject(err);
        };
        const onListening = () => {
          server.off('error', onError);
          const bound = server.address();
          this.port = bound !== null && typeof bound === 'object' ? bound.port : port;
          DATA_PORT = this.port;
          this.url = `http://${host}:${this.port}/`;
          resolve({ url: this.url, port: this.port });
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
      });
    },
    /** 关闭监听并断开已有连接；已关闭时静默返回。 */
    close() {
      return new Promise((resolve) => {
        if (!server.listening) {
          this.url = null;
          resolve();
          return;
        }
        server.close(() => {
          this.url = null;
          resolve();
        });
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      });
    },
    get listening() {
      return server.listening;
    },
  };
}

/* CLI 入口：直接 `node serve.mjs` 时启动并打印，被 import 时什么都不做。 */
function isCliEntry() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url));
  } catch (_) {
    return false;
  }
}

if (isCliEntry()) {
  const app = createAgentCenterServer({ port: PORT, host: HOST });
  app.listen().then(() => {
    log('AgentCenter H5 已启动');
    log(`  地址   ${app.url}`);
    log(`  根目录 ${ROOT}`);
    log(`  数据   ${fs.existsSync(dataFile()) ? dataFile() : '未找到（前端使用演示数据）'}`);
    log('  Ctrl+C 退出');
  }, (err) => {
    if (err.code === 'EADDRINUSE') {
      const m = `端口 ${PORT} 已被占用。换端口：node serve.mjs --port 8899`;
      console.error(m);
      fileLog(m);
      process.exit(1);
    }
    console.error('服务启动失败：', err.message);
    fileLog(`服务启动失败：${err.message}`);
    process.exit(1);
  });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      log('正在关闭服务…');
      app.close().then(() => process.exit(0));
      setTimeout(() => process.exit(0), 1500);
    });
  }
}
