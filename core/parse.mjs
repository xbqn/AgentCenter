// 会话 → 任务记录（TaskRecord，见《需求规格方案》§4.2）
// 只读解析：打开文件、读行、解析 JSON，绝不写回源目录（FR-SC-07）
import path from 'node:path';
import fs from 'node:fs';
import { parseJsonl, openSqlite, clip, hhmm, isoLocal, dayKey, exists, dirBytes, walkFiles, decompressZstdFrames } from './util.mjs';

const RUN_WINDOW_MS = 2 * 60 * 1000;      // mtime 2 分钟内视为进行中
const HEARTBEAT_WINDOW_MS = 60 * 1000;    // 心跳 60 秒内视为进行中
const GAP_MS = 5 * 60 * 1000;             // 活跃时长剔除 > 5 分钟空隙
const SPLIT_GAP_MS = 30 * 60 * 1000;      // 任务切分：用户消息间隔 > 30 分钟
const MAX_LINES = 6000;                    // 单会话最多解析行数，超出取尾部

/** 活跃时长：剔除相邻消息之间 > 5 分钟的空隙 */
export function activeMsOf(times) {
  if (!times.length) return 0;
  const ts = times.slice().sort((a, b) => a - b);
  let total = 0;
  for (let i = 1; i < ts.length; i++) {
    const d = ts[i] - ts[i - 1];
    if (d > 0 && d <= GAP_MS) total += d;
  }
  return total;
}

/** 状态判定（FR 状态规则：completed/running/waiting/interrupted/failed/pending） */
function judgeStatus(ctx) {
  const now = Date.now();
  const { lastMs, mtimeMs, lastRole, hasToolError, heartbeatMs, assistantTail } = ctx;
  if (heartbeatMs && now - heartbeatMs < HEARTBEAT_WINDOW_MS) {
    return { status: 'running', statusReason: '进程心跳 ' + Math.round((now - heartbeatMs) / 1000) + ' 秒前更新' };
  }
  if (mtimeMs && now - mtimeMs < RUN_WINDOW_MS) {
    return { status: 'running', statusReason: '最近一次写入 ' + Math.round((now - mtimeMs) / 1000) + ' 秒前' };
  }
  // 工具失败只有在「失败之后再无助手收尾」时才算中断，否则视为已恢复
  if (hasToolError && lastRole !== 'assistant') return { status: 'interrupted', statusReason: '工具调用连续失败后中断' };
  if (lastRole === 'user') return { status: 'waiting', statusReason: '末尾为用户消息，等待助手响应' };
  if (assistantTail && /(请确认|需要你|是否继续|等待你|请提供|要我继续)/.test(assistantTail)) {
    return { status: 'waiting', statusReason: '末尾提问等待用户确认' };
  }
  if (lastMs && now - lastMs < 24 * 3600 * 1000) return { status: 'completed', statusReason: '助手正常收尾' };
  if (lastMs) return { status: 'completed', statusReason: '会话已结束（历史记录）' };
  return { status: 'pending', statusReason: '会话内容为空或无法解析' };
}

/** 从 JSONL 行中抽取消息序列（适配不同 Agent 的行格式） */
function extractWorkbuddy(rows) {
  const msgs = [];
  let heartbeatMs = 0;
  let cwd = '';
  for (const j of rows) {
    if (j.cwd) cwd = j.cwd;
    const t = j.timestamp || j.time || 0;
    if (j.type === 'message') {
      const role = j.role === 'user' ? 'user' : 'assistant';
      let text = '';
      let toolCalls = 0;
      let toolError = false;
      const content = Array.isArray(j.content) ? j.content : [];
      for (const c of content) {
        if (!c || typeof c !== 'object') continue;
        if (c.type === 'input_text' || c.type === 'text') text += (c.text || '');
        else if (c.type === 'tool_use') toolCalls++;
        else if (c.type === 'tool_result' && c.is_error) toolError = true;
      }
      // 用户上下文注入不算真实提问
      if (role === 'user' && /<system-reminder|<user_info>|<identity_context>/.test(text)) {
        const cleaned = text.replace(/<system-reminder[\s\S]*?<\/system-reminder>/g, '')
          .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        text = cleaned;
        if (!text) continue;
      }
      msgs.push({ role, text, t, toolCalls, toolError });
    } else if (j.type === 'function_call' || j.type === 'tool_use') {
      msgs.push({ role: 'tool', text: j.name || '', t, toolCalls: 1, toolError: false });
    } else if (j.type === 'function_call_result') {
      const err = /<tool_use_error>/.test(JSON.stringify(j.output || {}));
      msgs.push({ role: 'tool', text: j.name || '', t, toolCalls: 0, toolError: err });
    } else if (j.type === 'session-meta') {
      if (t) heartbeatMs = Math.max(heartbeatMs, t);
    }
  }
  return { msgs, cwd, heartbeatMs };
}

function extractAtomcode(rows) {
  const msgs = [];
  let cwd = '';
  for (const j of rows) {
    const t = j.ts || (j.iso ? Date.parse(j.iso) : 0);
    if (j.cwd) cwd = j.cwd;
    if (j.user) msgs.push({ role: 'user', text: j.user, t, toolCalls: 0, toolError: false });
    if (j.assistant) msgs.push({ role: 'assistant', text: j.assistant, t, toolCalls: 0, toolError: false });
    if (Array.isArray(j.tools)) {
      for (const tl of j.tools) msgs.push({ role: 'tool', text: (tl && (tl.name || tl.tool)) || 'tool', t, toolCalls: 1, toolError: !!(tl && tl.error) });
    } else if (j.tools && typeof j.tools === 'object') {
      msgs.push({ role: 'tool', text: 'tool', t, toolCalls: 1, toolError: false });
    }
  }
  return { msgs, cwd, heartbeatMs: 0 };
}

function extractClaude(rows) {
  const msgs = [];
  let cwd = '';
  let sessionId = '';
  for (const j of rows) {
    if (j.cwd) cwd = j.cwd;
    if (j.sessionId) sessionId = j.sessionId;
    const t = j.timestamp ? (typeof j.timestamp === 'number' ? j.timestamp : Date.parse(j.timestamp)) : 0;
    const type = j.type;
    if (type === 'user' || type === 'assistant') {
      const c = j.message && j.message.content;
      let text = '';
      let toolCalls = 0;
      let toolError = false;
      if (typeof c === 'string') text = c;
      else if (Array.isArray(c)) {
        for (const part of c) {
          if (!part || typeof part !== 'object') continue;
          if (part.type === 'text') text += part.text || '';
          else if (part.type === 'thinking') text += part.thinking || part.text || '';   // Qoder/Claude 的思考块
          else if (part.type === 'tool_use') toolCalls++;
          else if (part.type === 'tool_result' && part.is_error) toolError = true;
        }
      }
      // Qoder 的用户行常带注入上下文；humanInput.text 是用户真正输入的内容
      if (type === 'user' && j.humanInput && typeof j.humanInput.text === 'string' && j.humanInput.text.trim()) {
        text = j.humanInput.text;
      }
      // Claude/Qoder 把工具结果也放在 role=user 的行里：这些行只有 tool_result、没有正文，
      // 不是真实用户提问。若不剔除，「首条用户消息」会被工具结果淹没，标题退化成助手消息。
      if (type === 'user' && !text.trim()) continue;
      // 自动续跑 / 目标提示是 agent 自己生成的，不算用户提问
      if (type === 'user' && AGENT_INJECTED.test(text.trim())) continue;
      msgs.push({ role: type, text, t, toolCalls, toolError });
    } else if (type === 'response_item' || type === 'event_msg') {
      const p = j.payload || {};
      const role = p.role === 'user' ? 'user' : p.role === 'assistant' ? 'assistant' : 'tool';
      let text = '';
      if (Array.isArray(p.content)) for (const c of p.content) text += c.text || '';
      else if (typeof p.message === 'string') text = p.message;
      msgs.push({ role, text, t, toolCalls: 0, toolError: false });
    } else if (type === 'summary') {
      msgs.push({ role: 'assistant', text: j.summary || '', t, toolCalls: 0, toolError: false });
    }
  }
  return { msgs, cwd, heartbeatMs: 0, sessionId };
}

/** DSH 运行时注入给模型的上下文，不是用户真实提问 */
const DSH_INJECTED = /^(Current runtime context\.|Time sampled while preparing turn|You are an AI agent|Current DSH file policy)/;

/** Qoder / Claude 的自动续跑与目标提示：由 agent 内部生成，不是用户输入 */
const AGENT_INJECTED = /^(A goal has been set\.|Continue working toward the active thread goal|Continue working on|The user has set a goal|\[SYSTEM\]|<goal>|<system>)/i;

/**
 * DeepSeek Harness（DSH）事件流解析。
 * 行类型是事件而非消息：user/message、assistant/message、tool/call、tool/result、todo/write…
 * assistant/message 自带完整 content[]（reasoning / text / tool-call），无需拼 chunk。
 * 系统注入的上下文（runtime context、system-reminder）不算真实用户提问。
 */
function extractDsh(rows) {
  const msgs = [];
  let cwd = '';
  let title = '';
  for (const j of rows) {
    const t = j.time || 0;
    const d = j.data || {};
    if (j.type === 'session') {
      // session 行是顶层结构：{type,version,id,createdAt,cwd,...}，cwd 不在 data 里
      if (j.cwd) cwd = j.cwd;
      else if (d.cwd) cwd = d.cwd;
      continue;
    }
    if (j.type === 'session/title') {
      if (d.title) title = d.title;
      continue;
    }
    if (j.type === 'user/message') {
      let text = '';
      for (const c of Array.isArray(d.content) ? d.content : []) {
        if (c && c.type === 'text') text += c.text || '';
      }
      // 插件注入的上下文（runtime context / 系统提示快照 / 时间采样）不是用户提问
      const src = d.source || {};
      if (src.kind === 'plugin' || DSH_INJECTED.test(text.trim()) || /<system-reminder/.test(text)) continue;
      if (!text.trim()) continue;
      msgs.push({ role: 'user', text, t, toolCalls: 0, toolError: false });
      continue;
    }
    if (j.type === 'assistant/message') {
      const m = d.message || {};
      let text = '';
      let reasoning = '';
      let toolCalls = 0;
      let toolError = false;
      for (const c of Array.isArray(m.content) ? m.content : []) {
        if (!c) continue;
        if (c.type === 'text') text += c.text || '';
        else if (c.type === 'reasoning') reasoning += c.text || '';
        else if (c.type === 'tool-call') toolCalls++;
      }
      if (text.trim() || reasoning.trim()) msgs.push({ role: 'assistant', text: text || reasoning, t, toolCalls, toolError });
      continue;
    }
    if (j.type === 'tool/call') {
      msgs.push({ role: 'tool', text: d.name || 'tool', t, toolCalls: 1, toolError: false });
      continue;
    }
    if (j.type === 'tool/result') {
      const content = ((d.message || {}).content) || [];
      const flat = JSON.stringify(content);
      const err = /"isError":true|is_error|"error"/.test(flat);
      msgs.push({ role: 'tool', text: 'result', t, toolCalls: 0, toolError: err });
      continue;
    }
    if (j.type === 'turn/end') {
      const kind = (d.reason || {}).kind;
      if (kind === 'error' || kind === 'aborted') msgs.push({ role: 'tool', text: 'turn-end:' + kind, t, toolCalls: 0, toolError: true });
    }
  }
  return { msgs, cwd, heartbeatMs: 0, title };
}

/** 会话文件 → 一个或多个任务（按用户消息间隔 > 30 分钟切分） */
export function segmentsFromMsgs(msgs) {
  const userIdx = msgs.map((m, i) => (m.role === 'user' ? i : -1)).filter((i) => i >= 0);
  if (!userIdx.length) return [{ start: 0, end: msgs.length - 1 }];
  const segs = [];
  let start = 0;
  for (let k = 1; k < userIdx.length; k++) {
    const prev = msgs[userIdx[k - 1]].t;
    const cur = msgs[userIdx[k]].t;
    if (cur - prev > SPLIT_GAP_MS) {
      segs.push({ start, end: userIdx[k] - 1 });
      start = userIdx[k];
    }
  }
  segs.push({ start, end: msgs.length - 1 });
  return segs;
}

/** 会话唯一标识：sessionId + 所属目录名，保证同一 UUID 在不同项目下互不覆盖 */
function sourceTag(session) {
  const dir = String(session.sourceFile || '').split('#')[0];
  const parts = dir.split(/[\\/]+/).filter(Boolean);
  // 取「会话文件名 + 上一级目录名」两级，既唯一又比整条路径短
  const file = (parts[parts.length - 1] || '').replace(/\.jsonl$/, '');
  const parent = parts[parts.length - 2] || '';
  return session.sessionId + '@' + parent;
}

/** 组装单个任务记录 */
function buildTask(ctx) {
  const { agent, session, msgs, seg, files, intermediates, sourceFile, cwd } = ctx;
  const slice = msgs.slice(seg.start, seg.end + 1);
  const times = slice.map((m) => m.t).filter(Boolean);
  const startedAt = times.length ? Math.min(...times) : (session.mtimeMs || 0);
  const endedAt = times.length ? Math.max(...times) : (session.mtimeMs || 0);
  const wallClockMs = Math.max(0, endedAt - startedAt);
  const activeMs = activeMsOf(times);
  const userMsgs = slice.filter((m) => m.role === 'user');
  const toolCalls = slice.reduce((s, m) => s + (m.toolCalls || 0), 0);
  const lastMsg = slice[slice.length - 1] || {};
  const lastReal = slice.slice().reverse().find((m) => m.role === 'user' || m.role === 'assistant') || {};
  const hasToolError = slice.some((m) => m.toolError);
  const firstUser = userMsgs[0] || {};
  const title = clip((firstUser.text || lastReal.text || session.title || '未命名任务'), 60);
  const st = judgeStatus({
    // 只有「最后一个分段」才可能因文件刚被写入而判定为进行中；
    // 同会话的早期分段已结束，不能跟着文件 mtime 一起变成 running。
    lastMs: endedAt, mtimeMs: seg.isLast ? session.mtimeMs : 0, lastRole: lastReal.role,
    hasToolError, heartbeatMs: seg.isLast ? (ctx.heartbeatMs || 0) : 0, assistantTail: lastReal.text || ''
  });
  // 任务级存储按「窗口估算」：会话文件大小按本段消息占比分摊，
  // 加上本段涉及的工具调用产生的中间文件（同会话多任务时不重复计全量）。
  const segMsgCount = slice.length;
  const allMsgCount = Math.max(msgs.length, 1);
  // 会话体积优先用 scan.mjs 算好的 sessionBytes（共享库已按会话平摊），其次退回源文件大小
  const sessionBytes = ctx.sessionBytes || session.bytes || 0;
  const windowedSessionBytes = seg.isLast
    ? Math.max(0, sessionBytes - Math.round(sessionBytes * ((seg.start || 0) / allMsgCount)))
    : Math.round(sessionBytes * (segMsgCount / allMsgCount));
  const segIntermediate = Math.round((ctx.sessionIntermediateBytes || 0) * (segMsgCount / allMsgCount));
  const storageBytes = files.reduce((s, f) => s + f.bytes, 0) + windowedSessionBytes + segIntermediate;
  return {
    // taskId 必须全局唯一：同一 sessionId 可能出现在多个项目目录下（WorkBuddy 实测复用 UUID），
    // 只拼 agent+session+seq 会碰撞，导致详情页打开错误任务。
    taskId: agent.id + ':' + sourceTag(session) + ':' + (seg.seq || 0),
    agentId: agent.id, agentName: agent.name,
    sessionId: session.sessionId,
    formatVersion: session.formatVersion,
    title,
    project: projectName(cwd || session.cwd || session.slug || session.sessionId),
    cwd: cwd || session.cwd || '',
    startedAt, endedAt,
    wallClockMs, activeMs,
    messageCount: slice.length,
    userMessageCount: userMsgs.length,
    toolCallCount: toolCalls,
    status: st.status, statusReason: st.statusReason,
    artifacts: files.filter((f) => f.final),
    intermediateFiles: intermediates,
    todos: extractTodos(slice, agent.name, sourceFile),
    storageBytes,
    lastMessagePreview: clip(lastReal.text || '', 120),
    sourceFile
  };
}

function projectName(p) {
  if (!p) return '—';
  const parts = String(p).replace(/[\\/]+$/, '').split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '—';
}

/** Windows 下把物理路径统一成反斜杠（FR-UI-11：路径按 \ 换行、便于人工核对） */
export function normPath(p) {
  if (!p) return '';
  const s = String(p);
  if (process.platform !== 'win32') return s;
  // 只把分隔符归一，不动盘符与文件名
  return s.replace(/\//g, '\\');
}

/** 待办抽取：助手消息里的勾选清单 / 「下一步」「待补充」段落 */
function extractTodos(msgs, agentName, sourceFile) {
  const out = [];
  for (const m of msgs) {
    if (m.role !== 'assistant' || !m.text) continue;
    const lines = String(m.text).split(/\r?\n/);
    for (const line of lines) {
      const mm = /^\s*(?:[-*+]|\d+[.)])\s+\[( |x|X)\]\s+(.{4,200})$/.exec(line);
      if (mm) { out.push({ text: mm[2].trim(), done: mm[1].toLowerCase() === 'x' }); continue; }
      const nn = /^\s*(?:下一步|待补充|待办|TODO)[:：]\s*(.{4,200})$/.exec(line);
      if (nn) out.push({ text: nn[1].trim(), done: false });
    }
  }
  // 去重 + 限量，id 稳定以便 localStorage 勾销对齐
  const seen = new Set();
  return out.filter((t) => {
    const k = t.text.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 40).map((t, i) => ({
    id: (agentName + ':' + (sourceFile || '')).length + ':' + i,
    text: t.text, done: t.done, source: agentName
  }));
}

/** 主入口：解析一个会话，返回任务数组 */
export async function parseSession(agent, session, opts = {}) {
  const fam = agent.family;
  let parsed = { msgs: [], cwd: '', heartbeatMs: 0 };
  let intermediates = [];
  let files = [];

  if (fam === 'dsh') {
    // DSH 的会话是「多帧追加」zstd，需逐帧解压后再按行解析
    const { text, frames, bad: badFrames, unavailable, reason } = decompressZstdFrames(session.sourceFile);
    // 旧版 Node 没有 zstd 能力：标记成「该 Agent 的正文不可读」，而不是报成解析失败
    if (unavailable) {
      return [{ __unavailable: true, reason: reason || '当前 Node 不支持 zstd 解压', sourceFile: session.sourceFile, family: fam }];
    }
    if (!text) return [{ __error: 'zstd 解压失败（' + frames + ' 帧，坏帧 ' + badFrames + '）', sourceFile: session.sourceFile }];
    const rows = [];
    let bad = 0;
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      try { rows.push(JSON.parse(line)); } catch { bad++; }
    }
    if (!rows.length) return [];
    parsed = extractDsh(rows);
    if (parsed.title && !session.title) session.title = parsed.title;
    if (bad && bad > rows.length * 0.5) {
      return [{ __error: 'DSH 事件行解析失败 ' + bad + '/' + (bad + rows.length) + ' 行', sourceFile: session.sourceFile }];
    }
  } else if (fam === 'workbuddy' || fam === 'atomcode' || fam === 'claude-jsonl' || fam === 'qoder') {
    const { rows, bad } = parseJsonl(session.sourceFile, MAX_LINES);
    if (!rows.length) return [];
    parsed = fam === 'workbuddy' ? extractWorkbuddy(rows) : fam === 'atomcode' ? extractAtomcode(rows) : extractClaude(rows);
    if (opts.heartbeatMs) parsed.heartbeatMs = Math.max(parsed.heartbeatMs || 0, opts.heartbeatMs);
    if (bad && bad > rows.length * 0.5) {
      // 超过一半行无法解析 → 视为解析失败，交给错误队列（FR-SC-06）
      return [{ __error: 'JSONL 行解析失败 ' + bad + '/' + (bad + rows.length) + ' 行', sourceFile: session.sourceFile }];
    }
  } else if (fam === 'opencode-db') {
    const db = await openSqlite(session.dbFile);
    if (!db) return [{ __error: 'SQLite 无法打开（可能是 WAL 锁）', sourceFile: session.sourceFile }];
    try {
      const ms = db.prepare('select data, time_created from message where session_id = ? order by time_created').all(session.sessionId);
      const parts = db.prepare('select data, message_id from part where session_id = ?').all(session.sessionId);
      const byMsg = {};
      for (const p of parts) {
        let d = {};
        try { d = JSON.parse(p.data); } catch { continue; }
        (byMsg[p.message_id] = byMsg[p.message_id] || []).push(d);
      }
      for (const m of ms) {
        let d = {};
        try { d = JSON.parse(m.data); } catch { continue; }
        const ps = byMsg[m.id] || [];
        let text = '';
        let toolCalls = 0;
        let toolError = false;
        for (const p of ps) {
          if (p.type === 'text') text += p.text || '';
          else if (p.type === 'tool') { toolCalls++; if (p.state && p.state.status === 'error') toolError = true; }
        }
        parsed.msgs.push({ role: d.role === 'user' ? 'user' : 'assistant', text, t: m.time_created, toolCalls, toolError });
      }
      parsed.cwd = session.cwd || '';
      // 会话级 todo 表 → 待办
      try {
        parsed.dbTodos = db.prepare('select content, status from todo where session_id = ?').all(session.sessionId)
          .map((r) => ({ text: r.content, done: r.status === 'completed' }));
      } catch { parsed.dbTodos = []; }
    } catch (e) {
      try { db.close(); } catch {}
      return [{ __error: 'SQLite 查询失败：' + e.message, sourceFile: session.sourceFile }];
    }
    try { db.close(); } catch {}
  } else if (fam === 'vscdb') {
    // CodeBuddy/Trae 的 state.vscdb 只存会话元信息（标题、cwd、状态、起止），
    // 消息正文在 IDE 内部存储里不可读，因此按「元信息任务」呈现，状态取原始 status。
    const raw = session.raw || {};
    const t0 = session.timeCreated || 0;
    const t1 = session.timeUpdated || t0;
    const stText = String(raw.status || '');
    const status = /complete|done|finished/i.test(stText) ? 'completed'
      : /run|active|progress/i.test(stText) ? 'running'
      : /wait|pending|input/i.test(stText) ? 'waiting' : 'completed';
    const title = clip(raw.title || session.title || '未命名任务', 60);
    const wall = Math.max(0, t1 - t0);
    // 只有元信息时无法算活跃时长：短会话（≤15 分钟）墙钟≈活跃，长会话标记未知
    const active = wall <= 15 * 60000 ? wall : 0;
    const t = {
      taskId: agent.id + ':' + sourceTag(session) + ':0',
      agentId: agent.id, agentName: agent.name, sessionId: session.sessionId,
      title,
      project: projectName(session.cwd || ''),
      cwd: session.cwd || '',
      startedAt: t0, endedAt: t1,
      wallClockMs: wall, activeMs: active,
      messageCount: 0, userMessageCount: 0, toolCallCount: 0,
      status,
      statusReason: 'IDE 会话状态：' + (stText || '未知') + '（正文存于 IDE 内部存储，H5 只读元信息）',
      artifacts: [], intermediateFiles: [],
      todos: [],
      // vscdb 是共享库：单个会话按会话数平摊库体积（opts.sessionBytes 由 scan.mjs 传入）
      storageBytes: Math.round(opts.sessionBytes || 0),
      lastMessagePreview: '',
      sourceFile: session.sourceFile
    };
    return [t];
  } else if (fam === 'electron') {
    // Electron 家族：无结构化会话可读，只产出「目录占用」一条记录
    return [];
  }

  if (!parsed.msgs.length) return [];
  const segs = segmentsFromMsgs(parsed.msgs);
  const tasks = [];
  segs.forEach((seg, i) => {
    const t = buildTask({
      agent, session, msgs: parsed.msgs, seg: { ...seg, seq: i, isLast: i === segs.length - 1 },
      files, intermediates, sourceFile: session.sourceFile, cwd: parsed.cwd,
      heartbeatMs: parsed.heartbeatMs, sessionBytes: opts.sessionBytes || 0
    });
    // 合并数据库里的待办
    if (parsed.dbTodos && parsed.dbTodos.length) {
      const have = new Set(t.todos.map((x) => x.text.toLowerCase()));
      let k = t.todos.length;
      for (const d of parsed.dbTodos) {
        if (have.has(d.text.toLowerCase())) continue;
        t.todos.push({ id: agent.name.length + ':' + k++, text: d.text, done: d.done, source: agent.name + ' todo 表' });
      }
    }
    tasks.push(t);
  });
  return tasks;
}
