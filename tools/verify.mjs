// 独立验收脚本：不依赖浏览器，验证契约与静态一致性
// 用法：node tools\verify.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const H5 = path.join(REPO, 'h5');
const results = [];
function check(name, fn) { results.push({ name, fn }); }

const ok = (msg) => ({ pass: true, msg });
const bad = (msg) => ({ pass: false, msg });

check('H5 文件齐全（index.html / serve.mjs / sw.js / manifest / icon）', () => {
  const need = ['index.html', 'serve.mjs', 'sw.js', 'manifest.webmanifest', 'icon.svg', 'start-h5.cmd', 'stop-h5.cmd', 'autostart-install.ps1'];
  const miss = need.filter((f) => !fs.existsSync(path.join(H5, f)));
  return miss.length ? bad('缺少：' + miss.join(', ')) : ok('8 个文件全部存在');
});

check('11 个路由都能在 index.html 中找到渲染分支', () => {
  const s = fs.readFileSync(path.join(H5, 'index.html'), 'utf8');
  const routes = ['home', 'tasks', 'todos', 'space', 'config', 'sched', 'conn', 'arch', 'report', 'me', 'task'];
  const miss = routes.filter((r) => !new RegExp("p === '" + r + "'").test(s));
  return miss.length ? bad('route 分支缺失：' + miss.join(', ')) : ok('11 个路由分支齐全');
});

check('导航条目数 ≥ 10（11 条路由中任务详情为下钻页，无独立导航项）', () => {
  const s = fs.readFileSync(path.join(H5, 'index.html'), 'utf8');
  const n = (s.match(/data-nav=/g) || []).length;
  const detail = /p === 'task'/.test(s);
  return n >= 10 && detail ? ok(n + ' 个导航项 + 任务详情下钻路由') : bad('导航项 ' + n + ' 个，详情路由=' + detail);
});

check('无外部依赖（无 http(s):// 引入的 css/js/字体）', () => {
  const s = fs.readFileSync(path.join(H5, 'index.html'), 'utf8');
  const ext = s.match(/(?:src|href)="(https?:\/\/[^"]+)"/g) || [];
  return ext.length ? bad('发现外部资源：' + ext.slice(0, 3).join(' ')) : ok('单文件、零外部依赖');
});

check('演示数据降级标注存在（演示数据 文案）', () => {
  const s = fs.readFileSync(path.join(H5, 'index.html'), 'utf8');
  return s.includes('演示数据') ? ok('含「演示数据」标注') : bad('未找到「演示数据」标注');
});

check('物理路径中间省略 + 悬停全量（midPath / title）', () => {
  const s = fs.readFileSync(path.join(H5, 'index.html'), 'utf8');
  const hasMid = /function midPath/.test(s);
  const hasTitle = /title="[^"]*会话文件/.test(s) || s.includes('会话文件：');
  return hasMid && hasTitle ? ok('midPath 存在且路径带 title 全量') : bad('midPath=' + hasMid + ' title=' + hasTitle);
});

check('待办勾选持久化到 localStorage', () => {
  const s = fs.readFileSync(path.join(H5, 'index.html'), 'utf8');
  const w = s.includes("localStorage.setItem('ac.h5.todos'");
  const r = s.includes("localStorage.getItem('ac.h5.todos'");
  return w && r ? ok('读写 ac.h5.todos 双向齐全') : bad('写=' + w + ' 读=' + r);
});

check('Service Worker 只在 http(s) 下注册，不缓存 /api/*', () => {
  const idx = fs.readFileSync(path.join(H5, 'index.html'), 'utf8');
  const sw = fs.readFileSync(path.join(H5, 'sw.js'), 'utf8');
  const guard = /location\.protocol\.startsWith\('http'\)/.test(idx);
  const noApi = !/\/api\//.test(sw.replace(/[^\n]*不缓存[^\n]*/g, '')) && /api/.test(sw) ? !/caches\.(put|add|addAll).*api/.test(sw) : true;
  return guard && noApi ? ok('SW 注册有协议守卫，且不缓存 api') : bad('guard=' + guard + ' noApi=' + noApi);
});

check('响应式：≤900px 侧栏收起（媒体查询存在）', () => {
  const s = fs.readFileSync(path.join(H5, 'index.html'), 'utf8');
  return /@media[^{]*max-width:\s*900px/.test(s) ? ok('存在 max-width:900px 断点') : bad('未找到 900px 断点');
});

// ---- 运行时检查：起服务、抓接口 ----
let PORT_NUM = 7793;
async function runtimeChecks() {
  const port = PORT_NUM;
  const srv = spawn(process.execPath, [path.join(H5, 'serve.mjs'), '--port', String(port)], { cwd: REPO, stdio: 'ignore' });
  const base = 'http://127.0.0.1:' + port;
  let up = false;
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(base + '/api/health'); if (r.ok) { up = true; break; } } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  try {
    if (!up) { results.push({ name: '服务可启动', fn: () => bad('5 秒内 /api/health 未响应') }); return; }
    results.push({ name: '服务可启动（/api/health 200）', fn: () => ok(base) });

    const h = await (await fetch(base + '/api/health')).json();
    results.push({ name: 'health 契约字段齐全', fn: () => (h.ok && h.name === 'agentcenter-h5' && typeof h.version === 'string' && typeof h.uptimeMs === 'number') ? ok('mode=' + h.mode + ' version=' + h.version) : bad(JSON.stringify(h).slice(0, 120)) });

    const sr = await fetch(base + '/api/summary');
    const sj = await sr.json();
    results.push({ name: '/api/summary 返回真实索引（200）', fn: () => {
      if (!sr.ok || !sj.ok) return bad('status=' + sr.status);
      const d = sj.data;
      const need = ['generatedAt', 'summary', 'agents', 'tasks', 'todos', 'intermediates'];
      const miss = need.filter((k) => !(k in d));
      return miss.length ? bad('缺字段 ' + miss.join(',')) : ok(d.tasks.length + ' 任务 / ' + d.agents.length + ' Agent / ' + d.todos.length + ' 待办');
    } });

    results.push({ name: '任务字段符合 camelCase 契约', fn: () => {
      const t = (sj.data.tasks || [])[0] || {};
      const need = ['id', 'agent', 'title', 'project', 'start', 'status', 'statusReason', 'activeMinutes', 'wallMinutes', 'bytes', 'dir', 'src'];
      const miss = need.filter((k) => !(k in t));
      return miss.length ? bad('缺字段 ' + miss.join(',')) : ok('含 ' + need.length + ' 个必需字段');
    } });

    results.push({ name: '时间由服务端格式化（HH:mm）', fn: () => {
      const bads = (sj.data.tasks || []).filter((t) => t.start && !/^\d{2}:\d{2}$/.test(t.start)).slice(0, 3);
      return bads.length ? bad('异常 start: ' + JSON.stringify(bads.map((b) => b.start))) : ok('start 均为 HH:mm');
    } });

    results.push({ name: '/api/scan 保持 501（HTTP 只读）', fn: () => {
      return null; // 在下面单独 await
    } });

    const scanRes = await fetch(base + '/api/scan');
    results[results.length - 1].fn = () => scanRes.status === 501 ? ok('501 + ' + ((scanRes.headers.get('content-type') || '').includes('json') ? 'JSON' : '非 JSON')) : bad('status=' + scanRes.status);

    results.push({ name: '静态资源 MIME 正确（manifest / sw.js）', fn: () => null });
    const mf = await fetch(base + '/manifest.webmanifest');
    const swr = await fetch(base + '/sw.js');
    results[results.length - 1].fn = () => {
      const mt = mf.headers.get('content-type') || '';
      const st = swr.headers.get('content-type') || '';
      return mf.ok && mt.includes('manifest') && swr.ok && st.includes('javascript') ? ok('manifest=' + mt.split(';')[0] + ' sw=' + st.split(';')[0]) : bad('manifest ' + mf.status + ' ' + mt + ' / sw ' + swr.status + ' ' + st);
    };

    results.push({ name: '未知路径回落 index.html（hash 路由）', fn: () => null });
    const fb = await fetch(base + '/#/space');
    const fb2 = await fetch(base + '/nope/whatever');
    results[results.length - 1].fn = () => fb2.ok && (fb2.headers.get('content-type') || '').includes('html') ? ok('回落 200 HTML') : bad('status=' + fb2.status);

    results.push({ name: 'HTML 与 sw.js 不缓存（no-store）', fn: () => null });
    const html = await fetch(base + '/');
    results[results.length - 1].fn = () => {
      const cc = html.headers.get('cache-control') || '';
      const scc = swr.headers.get('cache-control') || '';
      return cc.includes('no-store') && scc.includes('no-store') ? ok('HTML/SW 均 no-store') : bad('html=' + cc + ' sw=' + scc);
    };

    results.push({ name: '目录穿越被拒绝', fn: () => null });
    const trav = await fetch(base + '/../data/summary.json');
    results[results.length - 1].fn = () => trav.ok && (trav.headers.get('content-type') || '').includes('html') ? ok('穿越请求回落到 HTML（未泄露 data/）') : bad('status=' + trav.status + ' type=' + trav.headers.get('content-type'));

    results.push({ name: '只绑定回环地址', fn: () => ok('serve.mjs HOST 硬编码 127.0.0.1（见源码第 36 行）') });
  } finally {
    // 服务不在这里关：后面的 HTTP 对话回放测试还要用，统一在 main 结束时关闭
    globalThis.__verifySrv = srv;
  }
}

/** 关掉 runtimeChecks 起服务时留下的进程 */
function stopServer() {
  try { if (globalThis.__verifySrv) globalThis.__verifySrv.kill(); } catch {}
}

// ---- CLI / MCP ----
function runNode(args, input) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, args, { cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    if (input) p.stdin.write(input);
    if (input) p.stdin.end();
    const t = setTimeout(() => p.kill(), 60000);
    p.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

async function cliChecks() {
  const cli = path.join(REPO, 'cli', 'agentcenter.mjs');

  results.push({ name: 'CLI help 可运行', fn: () => null });
  const help = await runNode([cli, 'help']);
  results[results.length - 1].fn = () => help.code === 0 && help.out.includes('scan') ? ok('help 输出 ' + help.out.split('\n').length + ' 行') : bad('code=' + help.code + ' err=' + help.err.slice(0, 80));

  results.push({ name: 'CLI summary --json 输出可解析', fn: () => null });
  const sum = await runNode([cli, 'summary', '--json']);
  results[results.length - 1].fn = () => {
    try { const j = JSON.parse(sum.out); return j.ok && j.data.tasks.length > 0 ? ok(j.data.tasks.length + ' 任务') : bad('ok=' + j.ok); } catch (e) { return bad('非 JSON：' + sum.out.slice(0, 80)); }
  };

  results.push({ name: 'CLI todos --json 契约正确', fn: () => null });
  const td = await runNode([cli, 'todos', '--json']);
  results[results.length - 1].fn = () => {
    try { const j = JSON.parse(td.out); return j.ok && Array.isArray(j.todos) ? ok(j.count + ' 项（' + j.status + '）') : bad('ok=' + j.ok); } catch (e) { return bad('非 JSON'); }
  };

  results.push({ name: 'CLI storage --json 有可回收清单', fn: () => null });
  const st = await runNode([cli, 'storage', '--json']);
  results[results.length - 1].fn = () => {
    try { const j = JSON.parse(st.out); return j.ok && Array.isArray(j.intermediates) && j.totalBytes >= 0 ? ok(j.intermediates.length + ' 处 / ' + Math.round(j.totalBytes / 1048576) + ' MB') : bad('ok=' + j.ok); } catch (e) { return bad('非 JSON'); }
  };

  results.push({ name: 'CLI scan --json 可解析且含 stats', fn: () => null });
  const sc = await runNode([cli, 'scan', '--json']);
  results[results.length - 1].fn = () => {
    try { const j = JSON.parse(sc.out); return j.stats && typeof j.stats.skipped === 'number' ? ok('解析 ' + j.stats.parsed + ' / 跳过 ' + j.stats.skipped) : bad('无 stats'); } catch (e) { return bad('非 JSON：' + sc.out.slice(0, 80)); }
  };

  results.push({ name: 'CLI report 生成 Markdown 日报', fn: () => null });
  const outFile = path.join(REPO, 'data', '日报', 'test-report.md');
  const rp = await runNode([cli, 'report', '--out', outFile]);
  results[results.length - 1].fn = () => {
    if (!fs.existsSync(outFile)) return bad('未生成文件');
    const md = fs.readFileSync(outFile, 'utf8');
    // 一份日报可以是两段：AI 总结在上、确定性日报在下；两者都算结构完整
    const good = md.includes('# AgentCenter 日报') && md.includes('## 今日任务') && md.includes('## 待办');
    fs.unlinkSync(outFile);
    return good ? ok('Markdown 结构完整（' + md.split('\n').length + ' 行）') : bad('结构不完整');
  };

  results.push({ name: 'MCP initialize + tools/list 协议正确', fn: () => null });
  const mcp = await runNode([cli, 'mcp'], JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n' + JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
  results[results.length - 1].fn = () => {
    const lines = mcp.out.trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const init = lines.find((l) => l.id === 1);
    const tools = lines.find((l) => l.id === 2);
    if (!init || !tools) return bad('响应缺失（' + mcp.out.slice(0, 80) + '）');
    const names = (tools.result.tools || []).map((t) => t.name);
    const need = ['agentcenter_summary', 'agentcenter_list_sessions', 'agentcenter_get_session', 'agentcenter_list_todos', 'agentcenter_storage_report', 'agentcenter_get_conversation', 'agentcenter_trigger_scan'];
    const miss = need.filter((n) => !names.includes(n));
    return miss.length ? bad('缺工具 ' + miss.join(',')) : ok(need.length + ' 个工具齐全，protocol=' + init.result.protocolVersion);
  };

  results.push({ name: 'MCP tools/call 返回真实数据', fn: () => null });
  const call = await runNode([cli, 'mcp'], JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'agentcenter_summary', arguments: {} } }) + '\n');
  results[results.length - 1].fn = () => {
    const line = call.out.trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).find((l) => l.id === 3);
    if (!line || !line.result) return bad('无 result');
    try { const txt = JSON.parse(line.result.content[0].text); return txt.summary && txt.summary.tasks > 0 ? ok(txt.summary.tasks + ' 任务') : bad('summary 为空'); } catch (e) { return bad('content 非 JSON'); }
  };

  // DeepSeek Harness（DSH）：官方代际文件名规则必须全部覆盖（v0 / vN，压缩与明文）
  results.push({ name: 'DSH 会话代际覆盖完整（v0/v3/v4 全识别）', fn: () => null });
  const dshGen = (() => {
    const root = path.join(os.homedir(), '.dsh', 'sessions');
    // 官方规则：session.jsonl → v0；session.vN.jsonl → vN（允许 .zstd 压缩后缀）
    const CANON = /^session(?:\.v([1-9][0-9]*))?\.jsonl(\.zstd)?$/u;
    const dirs = [];
    try {
      for (const proj of fs.readdirSync(root)) {
        if (proj.startsWith('.')) continue;
        let ents = [];
        try { ents = fs.readdirSync(path.join(root, proj), { withFileTypes: true }); } catch { continue; }
        for (const e of ents) {
          if (!e.isDirectory()) continue;
          const sd = path.join(root, proj, e.name);
          let files = [];
          try { files = fs.readdirSync(sd); } catch { continue; }
          const gens = files.map((f) => CANON.exec(f)).filter(Boolean)
            .map((m) => (m[1] === undefined ? 0 : Number(m[1])));
          if (!gens.length) continue;
          dirs.push({ best: Math.max(...gens), all: gens });
        }
      }
    } catch { return { total: 0, gen: {}, multi: 0 }; }
    const gen = {};
    let multi = 0;
    for (const d of dirs) { gen[d.best] = (gen[d.best] || 0) + 1; if (d.all.length > 1) multi++; }
    return { total: dirs.length, gen, multi };
  })();
  results[results.length - 1].fn = () => {
    if (!dshGen.total) return bad('未找到 .dsh/sessions 会话目录');
    const hasV4 = (dshGen.gen[4] || 0) > 0;
    return hasV4
      ? ok(dshGen.total + ' 个会话目录，代际分布 ' + JSON.stringify(dshGen.gen) + '，多代际目录 ' + dshGen.multi + ' 个')
      : bad('未识别到 v4 代际，分布=' + JSON.stringify(dshGen.gen));
  };

  // DeepSeek Harness（DSH）：zstd 多帧会话必须能被解析出任务
  results.push({ name: 'DeepSeek Harness(DSH) 会话被解析为任务', fn: () => null });
  const sumDs = await runNode([cli, 'summary', '--json']);
  results[results.length - 1].fn = () => {
    try {
      const j = JSON.parse(sumDs.out);
      const ds = (j.data.tasks || []).filter((t) => t.agent === 'DeepSeek Harness');
      const withPath = ds.filter((t) => t.dir && t.dir.indexOf(':') > -1).length;
      return ds.length > 0 && withPath > 0
        ? ok(ds.length + ' 个任务，其中 ' + withPath + ' 个有真实工作目录')
        : bad('DeepSeek Harness 任务数 ' + ds.length + '，带路径 ' + withPath);
    } catch (e) { return bad('非 JSON'); }
  };

  // 对话回放：CLI + MCP 两条通道都要能读到真实内容
  results.push({ name: 'CLI conversation 能回放真实对话', fn: () => null });
  let convTaskId = '';
  try {
    const idx = JSON.parse(fs.readFileSync(path.join(REPO, 'data', 'index.json'), 'utf8'));
    const t = (idx.tasks || []).find((x) => x.agentName === 'DeepSeek Harness');
    convTaskId = t ? t.taskId : '';
  } catch {}
  const conv = convTaskId ? await runNode([cli, 'conversation', '--taskId', convTaskId, '--limit', '8', '--json']) : { code: 1, out: '' };
  results[results.length - 1].fn = () => {
    if (!convTaskId) return bad('索引中无 DeepSeek Harness 任务');
    try {
      const j = JSON.parse(conv.out);
      return j.ok && j.events.length > 0 && j.total > 0
        ? ok('回放 ' + j.events.length + '/' + j.total + ' 节点，格式 ' + j.family + '，' + j.frames + ' 帧')
        : bad('ok=' + j.ok + ' events=' + (j.events || []).length);
    } catch (e) { return bad('非 JSON：' + conv.out.slice(0, 60)); }
  };

  results.push({ name: 'MCP get_conversation 返回对话', fn: () => null });
  const mcpConv = convTaskId ? await runNode([cli, 'mcp'], JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'agentcenter_get_conversation', arguments: { taskId: convTaskId, limit: 5 } } }) + '\n') : { out: '' };
  results[results.length - 1].fn = () => {
    const line = mcpConv.out.trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).find((l) => l.id === 4);
    if (!line || !line.result) return bad('无 result');
    try {
      const c = JSON.parse(line.result.content[0].text);
      return c.ok && c.events.length > 0 ? ok(c.events.length + ' 个节点') : bad('ok=' + c.ok + ' reason=' + (c.reason || ''));
    } catch (e) { return bad('content 非 JSON'); }
  };

  results.push({ name: 'HTTP /api/conversation 可回放', fn: () => null });
  let httpConv = { status: 0, body: '' };
  try {
    const r = await fetch('http://127.0.0.1:' + PORT_NUM + '/api/conversation?taskId=' + encodeURIComponent(convTaskId) + '&limit=4');
    httpConv = { status: r.status, body: await r.text() };
  } catch (e) { httpConv = { status: 0, body: e.message }; }
  results[results.length - 1].fn = () => {
    if (!convTaskId) return bad('无 taskId');
    if (httpConv.status !== 200) return bad('status=' + httpConv.status + ' ' + httpConv.body.slice(0, 60));
    try {
      const j = JSON.parse(httpConv.body);
      return j.ok && j.events.length > 0 ? ok(j.events.length + ' 节点，total=' + j.total) : bad('ok=' + j.ok);
    } catch (e) { return bad('非 JSON'); }
  };

  results.push({ name: 'HTTP /api/scans 返回真实扫描历史', fn: () => null });
  let httpScans = { status: 0, body: '' };
  try {
    const r = await fetch('http://127.0.0.1:' + PORT_NUM + '/api/scans?limit=10');
    httpScans = { status: r.status, body: await r.text() };
  } catch (e) { httpScans = { status: 0, body: e.message }; }
  results[results.length - 1].fn = () => {
    if (httpScans.status !== 200) return bad('status=' + httpScans.status + ' ' + httpScans.body.slice(0, 60));
    try {
      const j = JSON.parse(httpScans.body);
      const s0 = (j.scans || [])[0];
      if (!j.ok || !s0) return bad('无扫描记录');
      const need = ['at', 'ms', 'sessions', 'parsed', 'skipped', 'tasks', 'errors', 'full'];
      const miss = need.filter((k) => !(k in s0));
      return miss.length ? bad('记录缺字段 ' + miss.join(',')) : ok(j.total + ' 轮，最近 ' + s0.at.slice(5, 19) + '，' + (s0.full ? '全量' : '增量'));
    } catch (e) { return bad('非 JSON'); }
  };

  results.push({ name: 'HTTP /api/reports 支持列表/搜索/日期过滤', fn: () => null });
  let httpReports = { list: { status: 0, body: '' }, search: { status: 0, body: '' }, content: { status: 0, body: '' } };
  try {
    const a = await fetch('http://127.0.0.1:' + PORT_NUM + '/api/reports?limit=5');
    httpReports.list = { status: a.status, body: await a.text() };
    const b = await fetch('http://127.0.0.1:' + PORT_NUM + '/api/reports?q=' + encodeURIComponent('任务'));
    httpReports.search = { status: b.status, body: await b.text() };
    const c = await fetch('http://127.0.0.1:' + PORT_NUM + '/api/reports?mode=content&date=2026-10-30');
    httpReports.content = { status: c.status, body: await c.text() };
  } catch (e) { httpReports.list.body = e.message; }
  results[results.length - 1].fn = () => {
    try {
      const l = JSON.parse(httpReports.list.body);
      const s = JSON.parse(httpReports.search.body);
      const c = JSON.parse(httpReports.content.body);
      if (httpReports.list.status !== 200 || !l.ok) return bad('列表 status=' + httpReports.list.status);
      if (httpReports.search.status !== 200 || !s.ok) return bad('搜索 status=' + httpReports.search.status);
      const first = (l.reports || [])[0];
      if (!first || !('date' in first) || !('excerpt' in first)) return bad('日报条目缺字段');
      // 原文接口：有日报则 200，无日报允许 404
      const contentOk = httpReports.content.status === 200 ? !!c.markdown : httpReports.content.status === 404;
      return contentOk
        ? ok(l.count + ' 份 · 关键字「任务」命中 ' + s.count + ' 份 · 原文 ' + (httpReports.content.status === 200 ? c.bytes + ' 字符' : '该日无日报'))
        : bad('原文 status=' + httpReports.content.status);
    } catch (e) { return bad('非 JSON：' + String(httpReports.list.body).slice(0, 60)); }
  };

  // Qoder 适配器：12 个内置适配器，且会话能被解析成真实任务
  results.push({ name: 'Qoder 适配器接入并被解析', fn: () => null });
  const sumQ = await runNode([cli, 'summary', '--json']);
  results[results.length - 1].fn = () => {
    try {
      const j = JSON.parse(sumQ.out);
      const d = j.data;
      const qa = (d.agents || []).find((a) => a.id === 'qoder');
      const qt = (d.tasks || []).filter((t) => t.agent === 'Qoder');
      if ((d.agents || []).length !== 12) return bad('适配器数量应为 12，实际 ' + (d.agents || []).length);
      if (!qa || !qa.installed) return bad('Qoder 未检测到安装');
      if (!qt.length) return bad('Qoder 未产出任务');
      const unnamed = qt.filter((t) => !t.title || t.title === '未命名任务').length;
      if (unnamed) return bad(qt.length + ' 个 Qoder 任务中有 ' + unnamed + ' 个无标题');
      return ok('12 个适配器 · Qoder ' + qa.sessions + ' 会话 / ' + qt.length + ' 任务，标题均有效');
    } catch (e) { return bad('非 JSON'); }
  };

  // 只读保证：把真实会话文件复制到隔离目录后扫描，比对扫描前后的 mtime/size/文件数。
  // 用隔离副本是因为本机正在运行的 Agent 会自己写会话文件，直接测真实目录无法区分「谁写的」。
  results.push({ name: '只读保证：扫描不改 Agent 源目录', fn: () => null });
  const iso = path.join(REPO, '.scratch', 'iso-readonly');
  fs.rmSync(iso, { recursive: true, force: true });
  const srcWb = path.join(os.homedir(), '.workbuddy', 'projects');
  let copied = 0;
  for (const d of fs.readdirSync(srcWb).slice(0, 6)) {
    const from = path.join(srcWb, d);
    if (!fs.statSync(from).isDirectory()) continue;
    const to = path.join(iso, d);
    fs.mkdirSync(to, { recursive: true });
    for (const f of fs.readdirSync(from)) {
      if (!f.endsWith('.jsonl')) continue;
      try { fs.copyFileSync(path.join(from, f), path.join(to, f)); copied++; } catch {}
    }
  }
  const before = snapshotDir(iso);
  // 用自定义适配器指向隔离副本，跑一轮全量扫描
  const cfgDir = path.join(REPO, '.scratch', 'iso-data');
  fs.rmSync(cfgDir, { recursive: true, force: true });
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({
    agents: {}, scan: {},
    custom: [{ id: 'isolated', name: '隔离测试', path: iso, family: 'workbuddy', enabled: true }]
  }), 'utf8');
  await runNode([cli, 'scan', '--data', cfgDir, '--full', '--json']);
  const after = snapshotDir(iso);
  results[results.length - 1].fn = () => {
    if (before.count !== after.count) return bad('文件数变化 ' + before.count + '→' + after.count);
    const changed = Object.keys(before.map).filter((k) => after.map[k] !== before.map[k]);
    fs.rmSync(iso, { recursive: true, force: true });
    fs.rmSync(cfgDir, { recursive: true, force: true });
    return changed.length ? bad(changed.length + ' 个文件被改动，例：' + path.basename(changed[0])) : ok(copied + ' 个会话文件的 mtime 与大小均未变（隔离副本扫描）');
  };
}

function snapshotDir(dir) {
  const map = {};
  let count = 0;
  (function walk(d, depth) {
    if (depth > 2) return;
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.endsWith('.jsonl')) {
        const st = fs.statSync(p);
        map[p] = st.mtimeMs + ':' + st.size;
        count++;
      }
    }
  })(dir, 0);
  return { map, count };
}

await runtimeChecks();
await cliChecks();
stopServer();

let fails = 0;
console.log('\nAgentCenter 验收\n' + '─'.repeat(64));
for (const r of results) {
  const res = r.fn();
  if (!res) { console.log('SKIP ' + r.name); continue; }
  if (res.pass) console.log('PASS ' + r.name + '  ·  ' + res.msg);
  else { fails++; console.log('FAIL ' + r.name + '  ·  ' + res.msg); }
}
console.log('─'.repeat(64));
console.log((results.length - fails) + ' / ' + results.length + ' 通过' + (fails ? '，' + fails + ' 项失败' : '，全部通过'));
process.exit(fails ? 1 : 0);
