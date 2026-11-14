// 对话详情读取：按任务回放原始会话文件，产出可展示的时间线
// 只读：仅读取会话源文件，绝不写回（FR-SC-07）
import path from 'node:path';
import { parseJsonl, openSqlite, decompressZstdFrames, decompressZstdFramesAsync, fileMayContain, clip, hhmm, isoLocal, exists } from './util.mjs';
import { ADAPTERS, detect } from './adapters.mjs';
import { normPath } from './parse.mjs';

const MAX_TURNS = 300;      // 单次回放最多节点数
const MAX_TEXT = 4000;      // 单条消息正文上限（超出截断并标注）
const MAX_RESULT = 1200;    // 工具结果上限

/** 按 taskId 找到索引里的任务记录 */
export function findTask(indexTasks, taskId) {
  return (indexTasks || []).find((t) => t.taskId === taskId || t.id === taskId) || null;
}

/** 该任务的适配器（按 agentId） */
function adapterOf(agentId) {
  return ADAPTERS.find((a) => a.id === agentId) || null;
}

/** 从源路径推断家族（索引里只有 agentId 时也可用） */
function familyOf(agentId, sourceFile) {
  const a = adapterOf(agentId);
  if (a) return a.family;
  if (/\.jsonl\.zstd$/.test(sourceFile)) return 'dsh';
  if (sourceFile.includes('opencode.db')) return 'opencode-db';
  if (sourceFile.endsWith('.vscdb')) return 'vscdb';
  return 'claude-jsonl';
}

function ev(role, time, text, extra) {
  return Object.assign({ role, time: hhmm(time) || '—', ts: time || 0, text: clip(String(text || ''), MAX_TEXT) }, extra || {});
}

/* DSH 运行时注入给模型的上下文，不是用户真实提问 */
const DSH_INJECTED = /^(Current runtime context\.|Time sampled while preparing turn|You are an AI agent|Current DSH file policy)/;


function timelineDsh(rows) {
  const out = [];
  let title = '';
  let cwd = '';
  for (const j of rows) {
    const t = j.time || 0;
    const d = j.data || {};
    if (j.type === 'session') { cwd = j.cwd || d.cwd || cwd; continue; }
    if (j.type === 'session/title') { if (d.title) title = d.title; continue; }
    if (j.type === 'user/message') {
      let text = '';
      for (const c of Array.isArray(d.content) ? d.content : []) if (c && c.type === 'text') text += c.text || '';
      const src = d.source || {};
      if (src.kind === 'plugin' || DSH_INJECTED.test(text.trim()) || /<system-reminder/.test(text)) continue;
      if (text.trim()) out.push(ev('user', t, text));
      continue;
    }
    if (j.type === 'assistant/message') {
      const m = d.message || {};
      const texts = [];
      const reasoning = [];
      const tools = [];
      for (const c of Array.isArray(m.content) ? m.content : []) {
        if (!c) continue;
        if (c.type === 'text' && c.text) texts.push(c.text);
        else if (c.type === 'reasoning' && c.text) reasoning.push(c.text);
        else if (c.type === 'tool-call') tools.push({ name: c.name, args: c.arguments });
      }
      if (reasoning.length) out.push(ev('think', t, reasoning.join('\n')));
      if (texts.length) out.push(ev('assistant', t, texts.join('\n')));
      for (const tc of tools) out.push(ev('tool', t, String(tc.name || 'tool') + '\n' + clip(tc.args || '', MAX_RESULT), { tool: tc.name }));
      continue;
    }
    if (j.type === 'tool/result') {
      const content = ((d.message || {}).content) || [];
      let text = '';
      for (const c of content) {
        for (const inner of Array.isArray(c.content) ? c.content : []) {
          if (inner && inner.type === 'text') text += inner.text || '';
        }
        if (c && c.type === 'text') text += c.text || '';
      }
      if (text.trim()) out.push(ev('result', t, clip(text, MAX_RESULT)));
      continue;
    }
    if (j.type === 'todo/write' && Array.isArray(d.todos)) {
      out.push(ev('todo', t, d.todos.map((x) => '[' + (x.status === 'completed' ? 'x' : ' ') + '] ' + x.content).join('\n')));
    }
  }
  return { title, cwd, events: out };
}

/* ------------------------------------------------------- WorkBuddy / AtomCode / Claude */
function timelineJsonl(rows, fam) {
  const out = [];
  let cwd = '';
  let title = '';
  for (const j of rows) {
    const t = j.timestamp || j.time || j.ts || (j.iso ? Date.parse(j.iso) : 0);
    if (j.cwd) cwd = j.cwd;
    if (fam === 'atomcode') {
      if (j.user) out.push(ev('user', t, j.user));
      if (j.assistant) out.push(ev('assistant', t, j.assistant));
      if (Array.isArray(j.tools)) for (const tl of j.tools) out.push(ev('tool', t, String((tl && (tl.name || tl.tool)) || 'tool') + '\n' + clip((tl && tl.arguments) || '', MAX_RESULT), { tool: tl && tl.name }));
      continue;
    }
    if (j.type === 'message') {
      const role = j.role === 'user' ? 'user' : 'assistant';
      let text = '';
      const tools = [];
      for (const c of Array.isArray(j.content) ? j.content : []) {
        if (!c || typeof c !== 'object') continue;
        if (c.type === 'input_text' || c.type === 'text') text += c.text || '';
        else if (c.type === 'tool_use') tools.push({ name: c.name, args: c.input });
        else if (c.type === 'tool_result') {
          let rt = '';
          if (typeof c.content === 'string') rt = c.content;
          else if (Array.isArray(c.content)) for (const x of c.content) rt += (x && x.text) || '';
          if (rt.trim()) out.push(ev('result', t, clip(rt, MAX_RESULT)));
        }
      }
      if (role === 'user' && /<system-reminder|<user_info>|<identity_context>/.test(text)) {
        text = text.replace(/<system-reminder[\s\S]*?<\/system-reminder>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      }
      if (text.trim()) out.push(ev(role, t, text));
      for (const tc of tools) out.push(ev('tool', t, String(tc.name || 'tool') + '\n' + clip(tc.args ? JSON.stringify(tc.args) : '', MAX_RESULT), { tool: tc.name }));
      continue;
    }
    if (j.type === 'function_call') {
      out.push(ev('tool', t, String(j.name || 'tool') + '\n' + clip(j.arguments || '', MAX_RESULT), { tool: j.name }));
      continue;
    }
    if (j.type === 'function_call_result') {
      const o = j.output || {};
      const text = typeof o === 'string' ? o : (o.text || '');
      if (text.trim()) out.push(ev('result', t, clip(text, MAX_RESULT)));
      continue;
    }
    if (j.type === 'user' || j.type === 'assistant') {
      const c = j.message && j.message.content;
      let text = '';
      const tools = [];
      if (typeof c === 'string') text = c;
      else if (Array.isArray(c)) {
        for (const part of c) {
          if (!part || typeof part !== 'object') continue;
          if (part.type === 'text') text += part.text || '';
          else if (part.type === 'tool_use') tools.push({ name: part.name, args: part.input });
          else if (part.type === 'tool_result') {
            let rt = '';
            if (typeof part.content === 'string') rt = part.content;
            else if (Array.isArray(part.content)) for (const x of part.content) rt += (x && x.text) || '';
            if (rt.trim()) out.push(ev('result', t, clip(rt, MAX_RESULT)));
          }
        }
      }
      if (text.trim()) out.push(ev(j.type, t, text));
      for (const tc of tools) out.push(ev('tool', t, String(tc.name || 'tool') + '\n' + clip(tc.args ? JSON.stringify(tc.args) : '', MAX_RESULT), { tool: tc.name }));
      continue;
    }
    if (j.type === 'summary' && j.summary) { title = j.summary; }
  }
  return { title, cwd, events: out };
}

/* ---------------------------------------------------------------- OpenCode */
async function timelineOpencode(sourceFile, sessionId) {
  const dbFile = sourceFile.split('#')[0];
  const db = await openSqlite(dbFile);
  if (!db) return { title: '', cwd: '', events: [], error: 'SQLite 无法打开（可能被占用）' };
  const out = [];
  let title = '';
  let cwd = '';
  try {
    const s = db.prepare('select title, directory from session where id = ?').get(sessionId);
    if (s) { title = s.title || ''; cwd = s.directory || ''; }
    const ms = db.prepare('select id, data, time_created from message where session_id = ? order by time_created').all(sessionId);
    const parts = db.prepare('select data, message_id from part where session_id = ?').all(sessionId);
    const byMsg = {};
    for (const p of parts) {
      let d = {};
      try { d = JSON.parse(p.data); } catch { continue; }
      (byMsg[p.message_id] = byMsg[p.message_id] || []).push(d);
    }
    for (const m of ms) {
      let d = {};
      try { d = JSON.parse(m.data); } catch { continue; }
      const role = d.role === 'user' ? 'user' : 'assistant';
      for (const p of byMsg[m.id] || []) {
        if (p.type === 'text' && p.text) out.push(ev(role, m.time_created, p.text));
        else if (p.type === 'reasoning' && p.text) out.push(ev('think', m.time_created, p.text));
        else if (p.type === 'tool') {
          const st = p.state || {};
          out.push(ev('tool', m.time_created, String(p.tool || 'tool') + '\n' + clip(st.input ? JSON.stringify(st.input) : '', MAX_RESULT), { tool: p.tool }));
          if (st.output) out.push(ev('result', m.time_created, clip(String(st.output), MAX_RESULT)));
        }
      }
    }
  } catch (e) {
    try { db.close(); } catch {}
    return { title, cwd, events: out, error: e.message };
  }
  try { db.close(); } catch {}
  return { title, cwd, events: out };
}

/* ---------------------------------------------------------------- vscdb */
async function timelineVscdb(sourceFile, sessionId) {
  // vscdb 只存会话元信息，正文在 IDE 内部存储里不可读
  const db = await openSqlite(sourceFile.split('#')[0]);
  if (!db) return { title: '', cwd: '', events: [], unavailable: true };
  let meta = null;
  try {
    const r = db.prepare('select value from ItemTable where key = ?').get('session:' + sessionId);
    if (r) meta = JSON.parse(r.value);
  } catch {}
  try { db.close(); } catch {}
  return {
    title: (meta && meta.title) || '',
    cwd: (meta && meta.cwd) || '',
    events: [],
    unavailable: true,
    note: '该 Agent（IDE 系）只把会话元信息写进 SQLite，消息正文保存在 IDE 内部存储中，无法只读解析。'
  };
}

/**
 * 回放一个任务的完整对话。
 * @param {object} task 索引中的任务记录（需含 taskId/agentId/sessionId/sourceFile）
 * @param {{limit?:number}} opts
 */
/**
 * 在一个任务的会话里搜关键词（含「思考」与工具输出）。
 *
 * 与 readConversation 共用同一套读取逻辑，因此命中范围与「对话详情」看到的完全一致。
 * 只返回命中摘要（角色 + 片段 + 位置），不返回整段正文——调用方按需再开对话详情。
 *
 * @param {object} task - 索引里的任务记录
 * @param {string} needle - 关键词（已小写，调用方保证非空）
 * @param {{includeThink?:boolean, includeTool?:boolean, limit?:number, maxHits?:number}} opts
 * @returns {Promise<{ok:boolean, hits?:object[], total?:number, reason?:string}>}
 */
/**
 * 为「会话内容深搜」生成可落盘的文本行（每行一个事件，前缀是 taskId + 角色 + 时间）。
 *
 * 深搜如果每次都重新解析 200+ 个会话、近 300 MB 原文，注定要几十秒；
 * 扫描时顺手把正文抽成纯文本行，深搜就退化成「在几十 MB 的文本里找字符串」。
 * 只写正文（不含路径、元数据），且随 data 目录一起被 .gitignore 排除。
 *
 * @param {object} task
 * @param {{limit?:number, includeTool?:boolean}} opts
 * @returns {Promise<{ok:boolean, lines?:string[], reason?:string}>}
 */
export async function conversationIndexLines(task, opts = {}) {
  const taskId = String(task.taskId || task.id || '');
  if (taskId === '') return { ok: false, reason: '缺少 taskId' };
  const includeTool = opts.includeTool === true;
  const conv = await readConversation(task, { limit: opts.limit || 4000, async: true });
  if (!conv.ok) return { ok: false, reason: conv.reason };
  // 同一会话文件会被切成多个任务（taskId 末段就是段序号 :0/:1/:2）。
  // readConversation 返回整份文件的事件，所以这里按「用户消息」重新分段，
  // 只取本任务那一段——否则同一文件里每个任务都会重复同一批命中片段。
  const segIndex = Number(String(taskId).split(':').pop()) || 0;
  const segs = [];
  let segStart = 0;
  for (let i = 1; i < (conv.events || []).length; i += 1) {
    const prev = conv.events[i - 1];
    const cur = conv.events[i];
    const prevMs = typeof prev.ts === 'number' ? prev.ts : Date.parse(String(prev.ts || '')) || 0;
    const curMs = typeof cur.ts === 'number' ? cur.ts : Date.parse(String(cur.ts || '')) || 0;
    // 与 parse.mjs 的切分规则一致：用户消息间隔 > 30 分钟
    if (cur.role === 'user' && prevMs > 0 && curMs > 0 && curMs - prevMs > 30 * 60 * 1000) {
      segs.push([segStart, i - 1]);
      segStart = i;
    }
  }
  segs.push([segStart, Math.max(0, (conv.events || []).length - 1)]);
  const bounds = segs[Math.min(segIndex, segs.length - 1)] || [0, (conv.events || []).length - 1];
  const scoped = (conv.events || []).slice(bounds[0], bounds[1] + 1);
  const lines = [];
  for (const e of scoped) {
    const role = e.role;
    if (role === 'todo') continue;
    if ((role === 'tool' || role === 'result') && !includeTool) continue;
    // 同一会话文件常被切成多个任务：只保留落在本任务时间窗内的节点，
    // 否则同一文件里的每个任务都会重复同一批命中片段。
    const body = String(e.text || '').replace(/[\r\n]+/g, ' ').trim();
    if (body === '') continue;
    lines.push(taskId + '\t' + role + '\t' + (e.time || '') + '\t' + body);
  }
  return { ok: true, lines };
}

export async function searchConversation(task, needle, opts = {}) {
  const q = String(needle || '').trim().toLowerCase();
  if (q === '') return { ok: true, hits: [], total: 0 };

  // 预筛：纯文本会话先看原文里有没有关键词，没有就不解析（很便宜）。
  // zstd 文件不做这一步——解压本身就是最贵的操作，交给下面的「按文件缓存 + 只解一次」。
  const sourceFile = String(task.sourceFile || task.src || '').split('#')[0];
  const fam = sourceFile ? familyOf(task.agentId, sourceFile) : '';
  // 只对「纯文本会话文件」做字节预筛：SQLite / LevelDB / zstd 的原始字节里搜不到正文
  const plainText = fam !== 'dsh' && fam !== 'vscdb' && fam !== 'opencode-db' && fam !== 'electron';
  if (plainText) {
    const prefilter = await fileMayContain(sourceFile, q, { zstd: false });
    if (!prefilter) return { ok: true, hits: [], total: 0, prefiltered: true };
  }

  // 深搜只需要「找到证据」：默认只回放前 800 个节点，命中即停，避免几万节点的完整回放
  const conv = await readConversation(task, { limit: opts.limit || 800, async: true });
  if (!conv.ok) return { ok: false, reason: conv.reason, sourceFile: conv.sourceFile };

  const includeThink = opts.includeThink === true;
  const includeTool = opts.includeTool === true;
  const maxHits = Math.min(Number(opts.maxHits) || 5, 20);
  const SKIP = includeThink ? ['todo'] : ['think', 'todo'];
  const SKIP_TOOL = includeTool ? [] : ['tool', 'result'];

  const hits = [];
  let total = 0;
  for (const e of conv.events || []) {
    if (SKIP.includes(e.role) || SKIP_TOOL.includes(e.role)) continue;
    const body = String(e.text || '');
    const at = body.toLowerCase().indexOf(q);
    if (at === -1) continue;
    total += 1;
    if (hits.length >= maxHits) break;   // 片段攒够了就不再扫后面的节点
    // 命中片段：关键词前后各留 60 字，去掉换行便于单行展示
    const from = Math.max(0, at - 60);
    const to = Math.min(body.length, at + q.length + 60);
    const snippet = (from > 0 ? '…' : '') + body.slice(from, to).replace(/\s+/g, ' ') + (to < body.length ? '…' : '');
    hits.push({
      role: e.role,
      roleLabel: { user: '用户', assistant: '助手', think: '思考', tool: '工具调用', result: '工具结果', todo: '待办' }[e.role] || e.role,
      time: e.time,
      snippet,
      at,
      tool: e.tool || '',
    });
  }
  return { ok: true, hits, total, events: (conv.events || []).length };
}

export async function readConversation(task, opts = {}) {
  if (!task) return { ok: false, reason: '任务不存在' };
  const sourceFile = String(task.sourceFile || task.src || '').split('#')[0];
  if (!sourceFile || !exists(sourceFile)) {
    return { ok: false, reason: '原始会话文件已不存在', sourceFile: normPath(task.sourceFile || '') };
  }
  const fam = familyOf(task.agentId, sourceFile);
  const limit = opts.limit || MAX_TURNS;
  let res = { title: '', cwd: '', events: [] };
  let frames = 0;

  try {
    if (fam === 'dsh') {
      // 深搜走异步解压（线程池 + 文件缓存），避免一个大会话把事件循环堵死
      const z = opts.async === true ? await decompressZstdFramesAsync(sourceFile) : decompressZstdFrames(sourceFile);
      frames = z.frames;
      const text = z.text;
      if (!text) return { ok: false, reason: 'zstd 解压失败（' + z.frames + ' 帧，坏帧 ' + z.bad + '）', sourceFile: normPath(sourceFile) };
      const rows = [];
      for (const line of text.split(/\r?\n/)) { if (!line) continue; try { rows.push(JSON.parse(line)); } catch {} }
      res = timelineDsh(rows);
    } else if (fam === 'opencode-db') {
      res = await timelineOpencode(sourceFile, task.sessionId);
    } else if (fam === 'vscdb') {
      res = await timelineVscdb(sourceFile, task.sessionId);
    } else {
      const { rows } = parseJsonl(sourceFile);
      res = timelineJsonl(rows, fam);
    }
  } catch (e) {
    return { ok: false, reason: '解析失败：' + e.message, sourceFile: normPath(sourceFile) };
  }

  const events = (res.events || []).slice(0, limit);
  const stat = exists(sourceFile) || { size: 0, mtimeMs: 0 };
  return {
    ok: true,
    taskId: task.taskId || task.id,
    agent: task.agentName || task.agent || '',
    title: res.title || task.title || '',
    cwd: normPath(res.cwd || task.cwd || ''),
    sourceFile: normPath(sourceFile),
    family: fam,
    formatVersion: task.formatVersion ?? null,
    bytes: stat.size,
    mtime: isoLocal(stat.mtimeMs),
    frames,
    total: (res.events || []).length,
    truncated: (res.events || []).length > limit,
    unavailable: !!res.unavailable,
    note: res.note || null,
    error: res.error || null,
    events: events.map((e) => ({
      role: e.role,
      time: e.time,
      // ts 是时间窗过滤的依据（正文索引按任务切分），必须一起带出来
      ts: e.ts || 0,
      text: e.text,
      tool: e.tool || null
    }))
  };
}

export { MAX_TURNS };
