#!/usr/bin/env node
// AgentCenter CLI：scan / summary / todos / storage / report / mcp（FR-MCP-02）
// 与 MCP、H5、主视图共用同一扫描内核（FR-MCP-03）
import fs from 'node:fs';
import path from 'node:path';
import { scan, DEFAULT_DATA_DIR, SUMMARY_FILE } from '../core/scan.mjs';
import { readJson, writeJsonAtomic, isoLocal, dayKey, hhmm } from '../core/util.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0] || 'help';
const flags = parseFlags(argv.slice(1));

function parseFlags(list) {
  const out = { _: [] };
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (k === 'json' || k === 'full' || k === 'help') { out[k] = true; continue; }
      const v = list[i + 1];
      if (v && !v.startsWith('--')) { out[k] = v; i++; } else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

const dataDir = flags.data ? path.resolve(flags.data) : DEFAULT_DATA_DIR;

function out(text) { process.stdout.write(text + '\n'); }
function json(obj) { process.stdout.write(JSON.stringify(obj, null, 2) + '\n'); }

function readSummary() {
  const j = readJson(SUMMARY_FILE(dataDir), null);
  if (!j) return null;
  // 兼容两种落盘形态：{ok,data:{...}} 与直接的数据对象
  return j.data ? j.data : j;
}

async function ensureSummary() {
  let s = readSummary();
  if (!s) {
    process.stderr.write('索引不存在，先执行一轮扫描…\n');
    s = await scan({ dataDir, agents: flags.agents ? String(flags.agents).split(',').map((x) => x.trim()) : null, full: !!flags.full });
  }
  return s;
}

function fmtMB(b) {
  const mb = b / 1048576;
  return mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : Math.round(mb) + ' MB';
}
function fmtMin(m) {
  return m >= 60 ? Math.floor(m / 60) + 'h' + (m % 60 ? m % 60 + 'm' : '') : m + 'm';
}
const STL = { completed: '已完成', running: '进行中', interrupted: '已中断', waiting: '等待确认', failed: '失败', pending: '待处理' };

async function main() {
  if (cmd === 'help' || flags.help) {
    out(`AgentCenter CLI

  node cli/agentcenter.mjs scan     [--agents workbuddy,codebuddy] [--full] [--json]
  node cli/agentcenter.mjs summary  [--range today|w7|d14] [--json]
  node cli/agentcenter.mjs todos    [--status pending|done|all] [--json]
  node cli/agentcenter.mjs storage  [--agent workbuddy] [--json]
  node cli/agentcenter.mjs report   [--date YYYY-MM-DD] [--out 路径.md]
  node cli/agentcenter.mjs conversation --taskId <id> [--limit N] [--json]
  node cli/agentcenter.mjs mcp              启动 stdio MCP Server
  node cli/agentcenter.mjs health           服务/索引状态

通用：--data <目录> 指定索引目录（默认仓库根 data/），--json 输出机器可读 JSON。
只读保证：扫描只读取 Agent 源目录，不写入、不删除任何源文件。`);
    return 0;
  }

  if (cmd === 'scan') {
    const agents = flags.agents ? String(flags.agents).split(',').map((s) => s.trim()).filter(Boolean) : null;
    const s = await scan({ dataDir, agents, full: !!flags.full });
    if (flags.json) { json(s); return 0; }
    out('扫描完成 · ' + s.stats.ms + ' ms');
    out('  会话 ' + s.stats.sessions + ' 个（解析 ' + s.stats.parsed + '，增量跳过 ' + s.stats.skipped + '）');
    out('  任务 ' + s.summary.tasks + ' 个 · 活跃 ' + fmtMin(s.summary.activeMinutes) + ' · 墙钟 ' + fmtMin(s.summary.wallMinutes));
    out('  占用 ' + fmtMB(s.summary.newBytes) + ' · 待办 ' + s.summary.pendingTodos + ' 项 · 错误 ' + s.errors.length + ' 条');
    for (const a of s.agents) {
      if (!a.installed && !a.disabled) continue;
      out('  ' + a.id.padEnd(11) + (a.disabled ? '已停用' : a.sessions + ' 会话 · ' + a.tasks + ' 任务 · ' + fmtMB(a.bytes || 0)));
    }
    if (s.errors.length) {
      out('  错误队列（前 5 条，单文件失败不影响整轮）：');
      for (const e of s.errors.slice(0, 5)) out('    ' + e.agent + ' :: ' + e.reason + ' :: ' + e.file);
    }
    if (Array.isArray(s.unavailable) && s.unavailable.length) {
      out('  跳过 ' + s.unavailable.length + ' 个会话（环境能力不足，不算错误）：');
      for (const e of s.unavailable.slice(0, 3)) out('    ' + e.agent + ' :: ' + e.reason);
    }
    return 0;
  }

  if (cmd === 'summary') {
    const s = await ensureSummary();
    const range = flags.range || 'today';
    if (flags.json) { json({ ok: true, range, data: s }); return 0; }
    const sum = s.summary;
    out('AgentCenter 概览 · ' + s.generatedAt);
    out('  任务 ' + sum.tasks + '（完成 ' + sum.done + ' · 进行中 ' + sum.running + ' · 中断 ' + sum.interrupted + ' · 等待 ' + sum.waiting + '）');
    out('  活跃 ' + fmtMin(sum.activeMinutes) + ' · 墙钟 ' + fmtMin(sum.wallMinutes) + ' · 占用 ' + fmtMB(sum.newBytes) + ' · 待办 ' + sum.pendingTodos);
    out('  Agent:');
    for (const a of s.agents.filter((x) => x.installed)) out('    ' + a.id.padEnd(11) + a.sessions + ' 会话 · ' + a.tasks + ' 任务 · ' + fmtMB(a.bytes || 0));
    out('  最近任务:');
    for (const t of s.tasks.slice(0, 5)) out('    ' + (t.start || '—') + ' ' + t.agent.padEnd(10) + (STL[t.status] || t.status).padEnd(5) + ' ' + t.title.slice(0, 40));
    return 0;
  }

  if (cmd === 'todos') {
    const s = await ensureSummary();
    const want = flags.status || 'pending';
    let list = s.todos || [];
    if (want === 'pending') list = list.filter((t) => !t.done);
    else if (want === 'done') list = list.filter((t) => t.done);
    if (flags.json) { json({ ok: true, status: want, count: list.length, todos: list }); return 0; }
    out('待办 ' + list.length + ' 项（' + (want === 'all' ? '全部' : want === 'done' ? '已完成' : '未完成') + '）');
    for (const t of list) out('  [' + (t.done ? 'x' : ' ') + '] ' + t.text + '  （' + t.agent + ' · ' + t.project + '）');
    if (!list.length) out('  （空）');
    return 0;
  }

  if (cmd === 'storage') {
    const s = await ensureSummary();
    const only = flags.agent;
    let list = s.intermediates || [];
    if (only) list = list.filter((i) => i.agent.toLowerCase() === String(only).toLowerCase());
    const total = list.reduce((a, i) => a + i.bytes, 0);
    if (flags.json) { json({ ok: true, agent: only || null, totalBytes: total, intermediates: list }); return 0; }
    out('中间文件合计 ' + fmtMB(total) + '（' + list.length + ' 处，仅统计，不自动删除）');
    for (const i of list) out('  ' + fmtMB(i.bytes).padStart(9) + '  ' + i.agent.padEnd(11) + i.label + '\n             ' + i.path);
    if (!list.length) out('  （没有可统计的中间文件目录）');
    return 0;
  }

  if (cmd === 'report') {
    const s = await ensureSummary();
    const { writeReport, queryReports } = await import('../core/report.mjs');
    // 只列出/搜索：不生成文件
    if (flags.list || flags.q || flags.from || flags.to) {
      const found = queryReports({ dataDir, summary: s, q: flags.q || '', from: flags.from || '', to: flags.to || '', limit: Number(flags.limit) || 30 });
      if (flags.json) { json({ ok: true, count: found.length, reports: found }); return 0; }
      out('日报 ' + found.length + ' 份');
      for (const r of found) out('  ' + r.date + '  ' + r.bytes + ' B  ' + r.excerpt.slice(0, 80));
      if (!found.length) out('  （无匹配，先用 report 生成某天的日报）');
      return 0;
    }
    const date = flags.date || dayKey(Date.now());
    if (flags.out) {
      // 自定义输出路径：只写指定文件
      const r = writeReport(s, dataDir, date);
      fs.writeFileSync(path.resolve(String(flags.out)), r.md, 'utf8');
      if (flags.json) { json({ ok: true, date, file: path.resolve(String(flags.out)) }); return 0; }
      out('日报已生成：' + path.resolve(String(flags.out)));
      return 0;
    }
    const r = writeReport(s, dataDir, date);
    if (flags.json) { json({ ok: true, date, file: r.file }); return 0; }
    out('日报已生成：' + r.file);
    return 0;
  }

  if (cmd === 'conversation' || cmd === 'conv') {
    const taskId = flags.taskId || flags.id || flags._[0];
    if (!taskId) { process.stderr.write('缺少 taskId。用法：node cli/agentcenter.mjs conversation --taskId <id>\n'); return 2; }
    const idx = readJson(path.join(dataDir, 'index.json'), { tasks: [] });
    const task = (idx.tasks || []).find((t) => t.taskId === taskId || t.id === taskId);
    if (!task) { process.stderr.write('索引中找不到该任务：' + taskId + '\n'); return 1; }
    const { readConversation } = await import('../core/conversation.mjs');
    const conv = await readConversation(task, { limit: Number(flags.limit) || 300 });
    if (flags.json) { json(conv); return conv.ok ? 0 : 1; }
    if (!conv.ok) { process.stderr.write('读取失败：' + conv.reason + '\n'); return 1; }
    out('对话回放 · ' + conv.agent + ' · ' + conv.title);
    out('  源文件 ' + conv.sourceFile);
    out('  节点 ' + conv.total + (conv.truncated ? '（已截断显示 ' + conv.events.length + ' 条）' : '') + ' · 格式 ' + conv.family + (conv.frames ? ' · ' + conv.frames + ' 帧' : ''));
    if (conv.note) out('  注意：' + conv.note);
    for (const e of conv.events) {
      const tag = { user: '用户', assistant: '助手', think: '思考', tool: '工具', result: '结果', todo: '待办' }[e.role] || e.role;
      out('  [' + e.time + '] ' + tag + '：' + String(e.text).replace(/\s+/g, ' ').slice(0, 200));
    }
    return 0;
  }

  if (cmd === 'daemon') {
    // 常驻调度：按 data/config.json 的 scan 规则定时扫描 + 生成日报
    const { startScheduler } = await import('../core/scheduler.mjs');
    const sched = await startScheduler({ dataDir });
    out('调度守护进程已启动（Ctrl+C 退出）。规则来自 data/config.json');
    const stop = () => { sched.stop(); process.exit(0); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    // 保持进程存活
    await new Promise(() => {});
    return 0;
  }

  if (cmd === 'config') {
    const core = await import('../core/scan.mjs');
    const cfg = core.readConfig(dataDir);
    if (flags.json) { json(cfg); return 0; }
    out('配置 · ' + (core.CONFIG_FILE(dataDir)));
    out('  Agent 覆盖 ' + Object.keys(cfg.agents).length + ' 项');
    for (const [id, v] of Object.entries(cfg.agents)) {
      out('    ' + id + '：' + (v.enabled === false ? '停用' : '启用') + (v.path ? ' · 路径 ' + v.path : ''));
    }
    out('  自定义适配器 ' + cfg.custom.length + ' 个');
    for (const c of cfg.custom) out('    ' + c.id + '：' + c.path);
    out('  扫描规则：' + JSON.stringify(cfg.scan));
    return 0;
  }

  if (cmd === 'health') {
    const s = readSummary();
    const j = { ok: !!s, dataDir, index: SUMMARY_FILE(dataDir), generatedAt: s ? s.generatedAt : null, tasks: s ? s.summary.tasks : 0 };
    if (flags.json) { json(j); return 0; }
    out((j.ok ? '索引正常' : '索引缺失') + ' · ' + j.index);
    if (j.ok) out('  生成于 ' + j.generatedAt + ' · 任务 ' + j.tasks);
    return 0;
  }

  if (cmd === 'mcp') {
    const { serveMcp } = await import('../mcp/server.mjs');
    await serveMcp({ dataDir });
    return 0;
  }

  process.stderr.write('未知命令：' + cmd + '\n运行 node cli/agentcenter.mjs help 查看用法。\n');
  return 2;
}

main().then((code) => process.exit(code || 0)).catch((e) => {
  process.stderr.write('执行失败：' + (e && e.stack ? e.stack : e) + '\n');
  process.exit(1);
});
