// 日报生成与读取：CLI / HTTP / MCP 共用同一份实现，避免格式分叉
// 日报落盘在 <dataDir>/日报/YYYY-MM-DD.md，同一天多次生成幂等覆盖（FR-SCH-03）
import fs from 'node:fs';
import path from 'node:path';
import { readJson, isoLocal, dayKey } from './util.mjs';

const STL = { completed: '已完成', running: '进行中', interrupted: '已中断', waiting: '等待确认', failed: '失败', pending: '待处理' };

function fmtMB(b) {
  const mb = (b || 0) / 1048576;
  return mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : Math.round(mb) + ' MB';
}
function fmtMin(m) {
  const v = m || 0;
  return v >= 60 ? Math.floor(v / 60) + 'h' + (v % 60 ? v % 60 + 'm' : '') : v + 'm';
}

/** 报告目录 */
export function reportDir(dataDir) {
  return path.join(dataDir, '日报');
}

/** 某天的报告文件路径 */
export function reportPath(dataDir, date) {
  return path.join(reportDir(dataDir), date + '.md');
}

/**
 * 按日期渲染 Markdown 日报。
 * 只统计「当天有活动」的任务：开始或结束落在该日。
 * @param {object} summary scan() 的返回数据
 * @param {string} date YYYY-MM-DD
 */
export function renderReport(summary, date) {
  const data = summary && summary.data ? summary.data : summary;
  const all = (data && data.tasks) || [];
  const tasks = all.filter((t) => {
    const s = (t.startedAt || '').slice(0, 10);
    const e = (t.endedAt || '').slice(0, 10);
    return s === date || e === date;
  });
  const todos = (data.todos || []).filter((t) => t.taskId && tasks.some((x) => x.id === t.taskId));
  const agents = (data.agents || []).filter((a) => a.installed);
  const sum = {
    n: tasks.length,
    done: tasks.filter((t) => t.status === 'completed').length,
    running: tasks.filter((t) => t.status === 'running').length,
    interrupted: tasks.filter((t) => t.status === 'interrupted').length,
    waiting: tasks.filter((t) => t.status === 'waiting').length,
    active: tasks.reduce((s, t) => s + (t.activeMinutes || 0), 0),
    wall: tasks.reduce((s, t) => s + (t.wallMinutes || 0), 0),
    bytes: tasks.reduce((s, t) => s + (t.bytes || 0), 0)
  };

  const rows = tasks.slice(0, 60).map((t) =>
    '| ' + t.agent + ' | ' + String(t.title).replace(/\|/g, '\\|') + ' | ' + t.project + ' | ' +
    (t.start || '—') + '–' + (t.end || '进行中') + ' | ' + fmtMin(t.activeMinutes) + ' | ' +
    (STL[t.status] || t.status) + ' | ' + fmtMB(t.bytes) + ' |');
  const todoLines = todos.map((t) => '- [' + (t.done ? 'x' : ' ') + '] ' + t.text + '（' + t.agent + ' · ' + t.project + '）');
  const dist = agents.map((a) => '- ' + a.name + '：' + a.sessions + ' 会话 · ' + a.tasks + ' 任务 · ' + fmtMB(a.bytes));

  return '# AgentCenter 日报 · ' + date + '\n\n' +
    '> 任务 ' + sum.n + ' 个 · 完成 ' + sum.done + ' · 进行中 ' + sum.running + ' · 中断 ' + sum.interrupted +
    ' · 等待 ' + sum.waiting + ' · 活跃 ' + fmtMin(sum.active) + ' · 墙钟 ' + fmtMin(sum.wall) +
    ' · 占用 ' + fmtMB(sum.bytes) + '\n\n' +
    '## 今日任务\n\n' +
    (rows.length ? '| Agent | 任务 | 项目 | 起止 | 活跃 | 状态 | 空间 |\n|---|---|---|---|---|---|---|\n' + rows.join('\n') : '（当日无任务）') + '\n\n' +
    '## 待办\n\n' + (todoLines.length ? todoLines.join('\n') : '（无）') + '\n\n' +
    '## 各 Agent 分布\n\n' + (dist.length ? dist.join('\n') : '（无）') + '\n\n' +
    '## 说明\n\n数据由 AgentCenter 只读扫描本地会话记录生成；不写入、不上传、不删除任何源文件。\n';
}

/* ============ 一份日报 = 两段 ============
   同一份 `data/<date>.md` 里可以同时容纳两部分：
     ## 日报总结（AI）          ← 模型生成的总结，放在上面
     ## 确定性日报（扫描生成）    ← 只读扫描出的事实清单，放在下面
   AI 只替换上面那段，永远不动下面那段；重新生成确定性日报时反过来也只动下面那段。 */
export const AI_MARK = '## 日报总结（AI）';
export const FACTS_MARK = '## 确定性日报';

/** 把一份日报拆成 { ai, deterministic }；没有 AI 段落时 ai 为 null。 */
export function splitReport(markdown) {
  const text = String(markdown || '');
  const aiAt = text.indexOf(AI_MARK);
  const factsAt = text.indexOf(FACTS_MARK);
  if (aiAt < 0) return { ai: null, deterministic: text.trim() };

  const aiStart = text.indexOf('\n', aiAt) + 1;
  const aiEnd = factsAt > aiAt ? text.lastIndexOf('\n', factsAt) : text.length;
  const block = text.slice(aiStart, aiEnd).replace(/\n+-{3,}\s*$/, '').trim();
  // 标题下一行是「> 模型 <model> · <time>」，取出来再剥掉
  const meta = /^>\s*模型\s+(.+?)\s+·\s*(.*)$/m.exec(block);
  const body = meta ? block.slice(block.indexOf('\n', block.indexOf(meta[0])) + 1).trim() : block;
  const deterministic = factsAt > aiAt ? text.slice(text.indexOf('\n', factsAt) + 1).trim() : '';
  return {
    ai: { model: meta ? meta[1].trim() : '', time: meta ? meta[2].trim() : '', body },
    deterministic,
  };
}

/** 组装：AI 总结在上、确定性日报在下。 */
export function composeReport(aiBody, deterministicBody, meta = {}) {
  const time = meta.time || new Date().toISOString().slice(0, 16).replace('T', ' ');
  return [
    AI_MARK,
    '',
    `> 模型 ${meta.model || '未知'} · ${time}`,
    '',
    String(aiBody || '').trim(),
    '',
    '---',
    '',
    `${FACTS_MARK}（扫描生成）`,
    '',
    String(deterministicBody || '').trim(),
    '',
  ].join('\n');
}

/** 生成并写入某天日报，返回文件路径与内容；已有的 AI 总结段落会被保留在最上面。 */
export function writeReport(summary, dataDir, date) {
  const deterministic = renderReport(summary, date);
  const existing = readReport(dataDir, date);
  const previous = existing ? splitReport(existing) : { ai: null };
  const md = previous.ai
    ? composeReport(previous.ai.body, deterministic, { model: previous.ai.model, time: previous.ai.time })
    : deterministic;
  const file = reportPath(dataDir, date);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, md, 'utf8');
  return { file, md, date };
}

/** 列出已落盘的日报日期（倒序） */
export function listReportDates(dataDir) {
  let names = [];
  try { names = fs.readdirSync(reportDir(dataDir)); } catch { return []; }
  return names
    .filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n))
    .map((n) => n.replace(/\.md$/, ''))
    .sort()
    .reverse();
}

/** 读取某天日报原文；不存在返回 null */
export function readReport(dataDir, date) {
  try { return fs.readFileSync(reportPath(dataDir, date), 'utf8'); } catch { return null; }
}

/**
 * 查询日报：支持关键字搜索 + 日期区间过滤。
 * 已落盘的文件优先；命中区间内缺失的日期可用 summary 现算（onlyExisting=false 时）。
 * @param {{dataDir:string, summary?:object, q?:string, from?:string, to?:string, limit?:number}} opts
 */
export function queryReports(opts) {
  const { dataDir, summary, q = '', from = '', to = '', limit = 30 } = opts;
  const kw = String(q || '').trim().toLowerCase();
  const dates = listReportDates(dataDir);
  const out = [];

  for (const date of dates) {
    if (from && date < from) continue;
    if (to && date > to) continue;
    const md = readReport(dataDir, date) || '';
    if (kw && !(date + '\n' + md.toLowerCase()).includes(kw)) continue;
    out.push({ date, source: 'file', bytes: md.length, excerpt: excerptOf(md, kw) });
    if (out.length >= limit) break;
  }

  // 若指定了单日且文件不存在，但能拿到索引数据，则即时生成一份（不落盘，仅用于展示）
  if (!out.length && from && to && from === to && summary) {
    const md = renderReport(summary, from);
    if (!kw || md.toLowerCase().includes(kw)) {
      out.push({ date: from, source: 'generated', bytes: md.length, excerpt: excerptOf(md, kw) });
    }
  }
  return out;
}

/** 摘取命中关键字附近的片段，便于列表预览。
    摘要要「可读」：跳过表格分隔行、表格管道与 Markdown 标记，只留正文语义。 */
function excerptOf(md, kw) {
  const plain = String(md || '').replace(/\r/g, '');
  const clean = (t) => t
    .split('\n')
    .filter((line) => !/^\s*\|?[-:\s|]+\|?\s*$/.test(line))   // 表格分隔行
    .filter((line) => !/^\s*#/.test(line))                        // 标题行
    .map((line) => line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').replace(/\|/g, ' · '))
    .join('\n')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!kw) {
    // 摘要优先给「核心指标」引用行 + 待办首条，比纯 Agent 分布更有信息量
    const quote = plain.match(/^>\s?(.+)$/m);
    const todoAt = plain.indexOf('## 待办');
    let todoPart = '';
    if (todoAt > -1) {
      const after = plain.slice(todoAt + 6);
      const body = clean(after).replace(/^（无）\s*/, '').replace(/^\(无\)\s*/, '');
      if (body && body !== '（无）') todoPart = body;
    }
    // 只取核心指标行（任务/完成/中断/活跃/占用），不带 Agent 分布，保持一行可读
    const head = quote ? clean(quote[1]) : '';
    if (head) return head.slice(0, 150);
    if (todoPart) return todoPart.slice(0, 150);
    const tasksAt = plain.indexOf('## 今日任务');
    return clean(tasksAt > -1 ? plain.slice(tasksAt + 8) : plain).slice(0, 180);
  }
  const at = plain.toLowerCase().indexOf(kw);
  if (at < 0) return clean(plain).slice(0, 180);
  const start = Math.max(0, at - 80);
  return (start > 0 ? '…' : '') + clean(plain.slice(start, at + kw.length + 140)).slice(0, 200);
}

export { fmtMB, fmtMin, STL };
