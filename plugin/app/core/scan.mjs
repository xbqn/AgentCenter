// 扫描调度与增量（FR-SC-01..07）
// 产物：data/index.json（任务索引）、data/fingerprints.json（增量指纹）、data/scans.json（扫描历史）、data/summary.json（H5/主视图/CLI/MCP 共用契约）
import fs from 'node:fs';
import path from 'node:path';
import { ADAPTERS, detect, listSessions, platformPaths, baseOf } from './adapters.mjs';
import { parseSession, normPath } from './parse.mjs';
import { readJson, writeJsonAtomic, writeTextAtomic, dirBytes, exists, isDir, isoLocal, hhmm, dayKey, clip } from './util.mjs';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
export const DEFAULT_DATA_DIR = path.join(REPO, 'data');
/** 深搜的分片索引目录（由 core/search-index.mjs 按需构建） */
export const SEARCH_DIR = (dataDir) => path.join(dataDir, 'search');

const INDEX_FILE = (d) => path.join(d, 'index.json');
const FP_FILE = (d) => path.join(d, 'fingerprints.json');
const SCANS_FILE = (d) => path.join(d, 'scans.json');
const SUMMARY_FILE = (d) => path.join(d, 'summary.json');
const OVERRIDES_FILE = (d) => path.join(d, 'overrides.json');

/** 指纹：mtime + size，命中则跳过解析（首扫增量目标 <15%） */
function fingerprintOf(sessions) {
  const fp = {};
  for (const s of sessions) fp[s.sourceFile + '|' + s.sessionId] = { mtimeMs: Math.round(s.mtimeMs || 0), size: s.bytes || 0 };
  return fp;
}

function fpKey(s) { return s.sourceFile + '|' + s.sessionId; }

/** 读取用户配置（监控开关 / 自定义路径 / 自定义适配器） */
function loadConfig(dataDir) {
  const cfgFile = path.join(dataDir, 'config.json');
  return readJson(cfgFile, { agents: {}, custom: [], scan: {} });
}

/**
 * 执行一轮扫描。
 * @param {{dataDir?:string, agents?:string[], full?:boolean, now?:number, write?:boolean}} opts
 */
export async function scan(opts = {}) {
  const startedAt = Date.now();
  const dataDir = opts.dataDir || DEFAULT_DATA_DIR;
  fs.mkdirSync(dataDir, { recursive: true });
  const cfg = loadConfig(dataDir);
  const only = opts.agents && opts.agents.length ? new Set(opts.agents) : null;
  const full = !!opts.full;
  const prevFp = full ? {} : readJson(FP_FILE(dataDir), {});
  const prevIndex = readJson(INDEX_FILE(dataDir), { tasks: [] });
  const prevTasks = Array.isArray(prevIndex.tasks) ? prevIndex.tasks : [];
  const prevByKey = {};
  for (const t of prevTasks) prevByKey[t.sourceFile + '|' + t.sessionId + '|' + (t.taskId || '')] = t;

  const errors = [];
  const unavailable = [];   // 能力缺失导致的跳过（例如旧版 Node 无 zstd）
  const tasks = [];
  const agentStats = [];
  const allSessions = [];
  let parsedCount = 0;
  let skippedCount = 0;

  for (const adapter of ADAPTERS) {
    if (only && !only.has(adapter.id)) continue;
    const conf = (cfg.agents && cfg.agents[adapter.id]) || {};
    if (conf.enabled === false) {
      agentStats.push({ id: adapter.id, name: adapter.name, installed: false, disabled: true, sessions: 0, bytes: 0, tasks: 0 });
      continue;
    }
    const det = detect(adapter, conf.path);
    let bytes = 0;
    let sessions = [];
    if (det.installed) {
      try {
        const root = baseOf(adapter, det.path);
        bytes = dirBytes(root, { maxFiles: 200000 });
        sessions = await listSessions(adapter, det.path);
      } catch (e) {
        errors.push({ agent: adapter.id, file: det.path, reason: '列举失败：' + e.message });
      }
    }
    allSessions.push(...sessions.map((s) => ({ ...s, agent: adapter.id })));
    // 共享库（vscdb / opencode.db）总大小：用于把库体积平摊到各会话
    let sharedDb = 0;
    const firstFile = sessions.find((s) => s.dbFile || s.sourceFile.endsWith('.vscdb'));
    if (firstFile) {
      const f = firstFile.dbFile || firstFile.sourceFile.split('#')[0];
      try { sharedDb = (fs.statSync(f)).size; } catch {}
    }

    let agentTasks = 0;
    for (const session of sessions) {
      const key = fpKey(session);
      const fp = prevFp[key];
      const fresh = { mtimeMs: Math.round(session.mtimeMs || 0), size: session.bytes || 0 };
      if (!full && fp && fp.mtimeMs === fresh.mtimeMs && fp.size === fresh.size) {
        // 未变更 → 复用上一轮任务。但「进行中」是**时间相关**的判定（mtime 在 N 分钟内），
        // 复用它会把「扫描当时刚好在写」的旧会话永远钉成 running。这类记录一律重解析，
        // 代价是每轮多解析几个会话，换来状态不会随扫描时刻漂移。
        const reused = prevTasks.filter((t) => t.sourceFile === session.sourceFile && t.sessionId === session.sessionId);
        const staleRunning = reused.some((t) => t.status === 'running' && Date.now() - fresh.mtimeMs > 2 * 60 * 1000);
        if (reused.length && !staleRunning) { tasks.push(...reused); agentTasks += reused.length; skippedCount++; continue; }
      }
      try {
        const out = await parseSession(adapter, session, {
          heartbeatMs: conf.heartbeatMs,
          // SQLite / vscdb 类适配器的多个会话共享同一个库文件，
          // 单会话大小按会话数平摊，避免一个库只算给第一条任务。
          sessionBytes: session.bytes || (sessions.length > 1 && sharedDb ? Math.round(sharedDb / sessions.length) : 0)
        });
        parsedCount++;
        for (const t of out) {
          if (t.__error) { errors.push({ agent: adapter.id, file: t.sourceFile, reason: t.__error }); continue; }
        // 能力缺失（如旧版 Node 无 zstd）：记一条提示，但不当作扫描错误
        if (t.__unavailable) { unavailable.push({ agent: adapter.id, file: t.sourceFile, reason: t.reason }); continue; }
          // 会话级存储计入该会话第一条任务，避免重复累加
          tasks.push(t); agentTasks++;
        }
      } catch (e) {
        // 单文件失败隔离：记入错误队列，继续下一个（FR-SC-06）
        errors.push({ agent: adapter.id, file: session.sourceFile, reason: e.message });
      }
    }
    agentStats.push({
      id: adapter.id, name: adapter.name, installed: det.installed,
      path: det.path, kind: adapter.kind, sessions: sessions.length, bytes, tasks: agentTasks
    });
  }

  // 自定义适配器（用户新增的通用 JSONL）
  for (const c of cfg.custom || []) {
    if (only && !only.has(c.id)) continue;
    if (c.enabled === false) continue;
    const fake = { id: c.id, name: c.name || c.id, kind: c.kind || 'JSONL', family: c.family || 'claude-jsonl', intermediates: [] };
    const det = detect(fake, c.path);
    if (!det.installed) { agentStats.push({ id: c.id, name: fake.name, installed: false, sessions: 0, bytes: 0, tasks: 0, custom: true }); continue; }
    try {
      const bytes = dirBytes(det.path, { maxFiles: 200000 });
      const sessions = await listSessions(fake, det.path);
      allSessions.push(...sessions.map((s) => ({ ...s, agent: c.id })));
      let n = 0;
      for (const s of sessions) {
        const out = await parseSession(fake, s, {});
        for (const t of out) { if (t.__error) { errors.push({ agent: c.id, file: t.sourceFile, reason: t.__error }); continue; } tasks.push(t); n++; }
      }
      agentStats.push({ id: c.id, name: fake.name, installed: true, path: det.path, kind: fake.kind, sessions: sessions.length, bytes, tasks: n, custom: true });
    } catch (e) { errors.push({ agent: c.id, file: c.path, reason: e.message }); }
  }

  // 存储：中间文件清单（只统计，不删除）
  const intermediates = [];
  for (const adapter of ADAPTERS) {
    const conf = (cfg.agents && cfg.agents[adapter.id]) || {};
    if (conf.enabled === false) continue;
    const det = detect(adapter, conf.path);
    if (!det.installed) continue;
    const root = baseOf(adapter, det.path);
    if (!isDir(root)) continue;
    for (const item of adapter.intermediates || []) {
      const target = path.join(root, item.sub);
      if (!exists(target)) continue;
      let bytes = 0;
      try { bytes = dirBytes(target, { maxFiles: 200000 }); } catch { continue; }
      if (bytes <= 0) continue;
      intermediates.push({
        path: target, label: adapter.name + ' ' + item.reason,
        agent: adapter.name, bytes, reclaimable: true
      });
    }
  }
  intermediates.sort((a, b) => b.bytes - a.bytes);

  // 人工覆盖：用户在 H5 里把「已中断 / 等待确认」标记为已完成。
  // 只写索引目录下的 overrides.json，绝不写 Agent 源目录（FR-SC-07 / FR-UI-05）。
  const overridden = applyOverrides(tasks, readOverrides(dataDir));

  // 汇总
  const now = opts.now || Date.now();
  const day = dayKey(now);
  const today = tasks.filter((t) => dayKey(t.startedAt || now) === day || dayKey(t.endedAt || now) === day);
  const todos = [];
  for (const t of tasks) {
    for (const td of t.todos || []) {
      todos.push({ id: t.taskId + ':' + td.id, text: td.text, agent: t.agentName, project: t.project, done: !!td.done, taskId: t.taskId });
    }
  }
  const sum = {
    tasks: tasks.length,
    done: tasks.filter((t) => t.status === 'completed').length,
    running: tasks.filter((t) => t.status === 'running').length,
    interrupted: tasks.filter((t) => t.status === 'interrupted').length,
    waiting: tasks.filter((t) => t.status === 'waiting').length,
    activeMinutes: Math.round(tasks.reduce((s, t) => s + (t.activeMs || 0), 0) / 60000),
    wallMinutes: Math.round(tasks.reduce((s, t) => s + (t.wallClockMs || 0), 0) / 60000),
    newBytes: agentStats.reduce((s, a) => s + (a.bytes || 0), 0),
    pendingTodos: todos.filter((t) => !t.done).length
  };

  const summary = {
    generatedAt: isoLocal(now),
    range: opts.range || 'today',
    summary: sum,
    agents: agentStats,
    tasks: tasks.map(publicTask),
    todos: todos.slice(0, 500),
    intermediates: intermediates.map((i) => ({ ...i })),
    trend: buildTrend(tasks, now),
    errors: errors.slice(0, 200),
    unavailable: unavailable.slice(0, 200),
    stats: { parsed: parsedCount, skipped: skippedCount, sessions: allSessions.length, ms: Date.now() - startedAt }
  };

  if (opts.write !== false) {
    // data/summary.json 直接存「数据对象」本身，由 serve.mjs 包成 {ok,range,data}
    writeJsonAtomic(SUMMARY_FILE(dataDir), summary);
    writeJsonAtomic(INDEX_FILE(dataDir), {
      version: 1, generatedAt: summary.generatedAt,
      tasks: tasks.map((t) => ({ ...t, artifacts: t.artifacts, intermediateFiles: t.intermediateFiles, todos: t.todos }))
    });
    writeJsonAtomic(FP_FILE(dataDir), fingerprintOf(allSessions));
    const prev = readJson(SCANS_FILE(dataDir), { scans: [] });
    const scans = Array.isArray(prev.scans) ? prev.scans : [];
    scans.unshift({
      at: summary.generatedAt, ms: summary.stats.ms,
      sessions: summary.stats.sessions, parsed: parsedCount, skipped: skippedCount,
      tasks: tasks.length, errors: errors.length, unavailable: unavailable.length, full
    });
    writeJsonAtomic(SCANS_FILE(dataDir), { scans: scans.slice(0, 50) });
  }

  return summary;
}

/* ============ 配置读写（data/config.json） ============ */
/* H5 配置中心此前只写 localStorage，扫描内核读的是 data/config.json，两边不通——
   界面上改的启停/路径对实际扫描无效。这里提供统一的读写入口，让 UI 改动真正生效。 */

export const CONFIG_FILE = (dataDir) => path.join(dataDir, 'config.json');

/** 读取完整配置（缺省给空结构，保证调用方无需判空） */
export function readConfig(dataDir = DEFAULT_DATA_DIR) {
  const j = readJson(CONFIG_FILE(dataDir), null) || {};
  return {
    version: 1,
    agents: (j.agents && typeof j.agents === 'object') ? j.agents : {},
    custom: Array.isArray(j.custom) ? j.custom : [],
    scan: (j.scan && typeof j.scan === 'object') ? j.scan : {},
    updatedAt: j.updatedAt || null
  };
}

/** 覆盖写入配置（原子写；只写索引目录，不触碰任何 Agent 源目录） */
export function writeConfig(patch, dataDir = DEFAULT_DATA_DIR) {
  const cur = readConfig(dataDir);
  const next = {
    version: 1,
    agents: patch.agents && typeof patch.agents === 'object' ? patch.agents : cur.agents,
    custom: Array.isArray(patch.custom) ? patch.custom : cur.custom,
    scan: patch.scan && typeof patch.scan === 'object' ? patch.scan : cur.scan,
    updatedAt: isoLocal(Date.now())
  };
  writeJsonAtomic(CONFIG_FILE(dataDir), next);
  return { ok: true, config: next };
}

/**
 * 更新单个 Agent 的配置项（启用状态 / 自定义路径 / 心跳）。
 * @param {string} agentId
 * @param {{enabled?:boolean, path?:string, heartbeatMs?:number}} patch
 */
export function setAgentConfig(agentId, patch, dataDir = DEFAULT_DATA_DIR) {
  if (!agentId) return { ok: false, reason: '缺少 agentId' };
  const cur = readConfig(dataDir);
  const prev = cur.agents[agentId] || {};
  const next = { ...prev };
  if (patch && typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
  if (patch && typeof patch.path === 'string') next.path = patch.path.trim();
  if (patch && typeof patch.heartbeatMs === 'number') next.heartbeatMs = patch.heartbeatMs;
  cur.agents[agentId] = next;
  return writeConfig({ agents: cur.agents, custom: cur.custom, scan: cur.scan }, dataDir);
}

/** 恢复某 Agent（或全部）的默认路径：删除 path 覆盖 */
export function resetAgentPath(agentId, dataDir = DEFAULT_DATA_DIR) {
  const cur = readConfig(dataDir);
  if (agentId) {
    if (cur.agents[agentId]) {
      const next = { ...cur.agents[agentId] };
      delete next.path;
      cur.agents[agentId] = next;
    }
  } else {
    for (const id of Object.keys(cur.agents)) {
      const next = { ...cur.agents[id] };
      delete next.path;
      cur.agents[id] = next;
    }
  }
  return writeConfig({ agents: cur.agents, custom: cur.custom, scan: cur.scan }, dataDir);
}

/** 新增 / 更新一个自定义适配器（通用 JSONL 家族） */
export function upsertCustomAdapter(adapter, dataDir = DEFAULT_DATA_DIR) {
  if (!adapter || !adapter.id || !adapter.path) return { ok: false, reason: '自定义适配器需要 id 与 path' };
  const cur = readConfig(dataDir);
  const idx = cur.custom.findIndex((c) => c.id === adapter.id);
  const item = {
    id: adapter.id,
    name: adapter.name || adapter.id,
    path: adapter.path,
    family: adapter.family || 'claude-jsonl',
    kind: adapter.kind || 'JSONL',
    enabled: adapter.enabled !== false,
    glob: adapter.glob || '*.jsonl'
  };
  if (idx > -1) cur.custom[idx] = item;
  else cur.custom.push(item);
  return writeConfig({ agents: cur.agents, custom: cur.custom, scan: cur.scan }, dataDir);
}

export function removeCustomAdapter(id, dataDir = DEFAULT_DATA_DIR) {
  const cur = readConfig(dataDir);
  cur.custom = cur.custom.filter((c) => c.id !== id);
  return writeConfig({ agents: cur.agents, custom: cur.custom, scan: cur.scan }, dataDir);
}

/* ============ 人工覆盖（只写索引目录，不动 Agent 源目录） ============ */

/** 可被「标记完成」的状态：只有机器判为未收尾的任务才需要人工确认 */
export const MARKABLE_STATUSES = new Set(['interrupted', 'waiting', 'failed', 'pending']);

export function readOverrides(dataDir = DEFAULT_DATA_DIR) {
  const j = readJson(OVERRIDES_FILE(dataDir), null);
  return { version: 1, tasks: (j && j.tasks) || {} };
}

/**
 * 把某个任务标记为已完成（或撤销标记）。
 * 只写 data/overrides.json；下一轮扫描会把它应用到 summary/index，任务不再出现在「已中断/等待确认」。
 * @param {string} taskId
 * @param {{dataDir?:string, done?:boolean, reason?:string, now?:number}} opts
 */
export function setTaskDone(taskId, opts = {}) {
  const dataDir = opts.dataDir || DEFAULT_DATA_DIR;
  if (!taskId) return { ok: false, reason: '缺少 taskId' };
  const cur = readOverrides(dataDir);
  const done = opts.done === false ? false : true;
  if (done) {
    cur.tasks[taskId] = {
      done: true,
      at: isoLocal(opts.now || Date.now()),
      reason: opts.reason || '人工标记完成'
    };
  } else {
    delete cur.tasks[taskId];
  }
  writeJsonAtomic(OVERRIDES_FILE(dataDir), { version: 1, generatedAt: isoLocal(opts.now || Date.now()), tasks: cur.tasks });
  return { ok: true, taskId, done, overrides: cur.tasks };
}

/** 把覆盖应用到内存中的任务数组（scan 内部与「只刷新 summary」时共用） */
export function applyOverrides(tasks, overrides) {
  const ov = (overrides && overrides.tasks) || {};
  let n = 0;
  for (const t of tasks) {
    const o = ov[t.taskId];
    if (!o) {
      // 撤销：恢复机器原始判定（index.json 里存的是覆盖后的 completed，需要从 autoStatus 还原）
      if (t.manualDone && t.autoStatus) {
        t.status = t.autoStatus;
        t.statusReason = t.autoStatusReason || t.statusReason;
        delete t.autoStatus;
        delete t.autoStatusReason;
        delete t.manualDone;
        delete t.manualDoneAt;
        n++;
      }
      continue;
    }
    if (t.status === 'completed' && !t.autoStatus) continue;   // 本来就已完成，无需覆盖
    if (!t.autoStatus) t.autoStatus = t.status;               // 只在首次覆盖时记录原判定
    t.autoStatusReason = t.autoStatusReason || t.statusReason;
    t.status = 'completed';
    t.statusReason = (o.reason || '人工标记完成') + '（人工覆盖，原判定：' + (t.autoStatusReason || t.autoStatus) + '）';
    t.manualDone = true;
    t.manualDoneAt = o.at || null;
    n++;
  }
  return n;
}

/** 重新生成 summary.json 里的汇总数字（覆盖后调用，避免必须重扫） */
export function refreshSummaryFromIndex(dataDir = DEFAULT_DATA_DIR) {
  const idx = readJson(INDEX_FILE(dataDir), { tasks: [] });
  const tasks = Array.isArray(idx.tasks) ? idx.tasks : [];
  const n = applyOverrides(tasks, readOverrides(dataDir));
  const sum = readJson(SUMMARY_FILE(dataDir), null);
  const data = sum && sum.data ? sum.data : sum;
  if (!data) return { ok: false, reason: '索引尚未生成' };
  const pub = tasks.map(publicTask);
  data.tasks = pub;
  data.summary = {
    ...(data.summary || {}),
    tasks: pub.length,
    done: pub.filter((t) => t.status === 'completed').length,
    running: pub.filter((t) => t.status === 'running').length,
    interrupted: pub.filter((t) => t.status === 'interrupted').length,
    waiting: pub.filter((t) => t.status === 'waiting').length
  };
  data.overridesApplied = n;
  writeJsonAtomic(SUMMARY_FILE(dataDir), data);
  // index.json 是权威任务索引，也必须同步，否则下次增量扫描会复用旧的未覆盖记录
  writeJsonAtomic(INDEX_FILE(dataDir), { ...idx, version: idx.version || 1, generatedAt: data.generatedAt || idx.generatedAt, tasks });
  return { ok: true, applied: n, tasks: pub.length, summary: data.summary };
}


function publicTask(t) {
  return {
    id: t.taskId, agent: t.agentName, agentId: t.agentId, sessionId: t.sessionId,
    formatVersion: t.formatVersion ?? null,
    title: t.title, project: t.project,
    start: hhmm(t.startedAt), end: t.endedAt ? hhmm(t.endedAt) : null,
    activeMinutes: Math.round((t.activeMs || 0) / 60000),
    wallMinutes: Math.round((t.wallClockMs || 0) / 60000),
    status: t.status, statusReason: t.statusReason,
    // 人工覆盖信息：前端据此显示「人工完成」标记，并知道原始机器判定
    manualDone: !!t.manualDone,
    manualDoneAt: t.manualDoneAt || null,
    autoStatus: t.autoStatus || null,
    autoStatusReason: t.autoStatusReason || null,
    messages: t.messageCount, toolCalls: t.toolCallCount,
    bytes: t.storageBytes, files: (t.artifacts || []).length + (t.intermediateFiles || []).length,
    todos: (t.todos || []).filter((x) => !x.done).length,
    dir: normPath(t.cwd), src: normPath(t.sourceFile),
    lastMessagePreview: t.lastMessagePreview,
    startedAt: isoLocal(t.startedAt), endedAt: isoLocal(t.endedAt)
  };
}

/** 近 14 天趋势：每日任务数与活跃分钟 */
function buildTrend(tasks, now) {
  const out = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now - i * 86400000);
    const key = dayKey(d.getTime());
    const dayTasks = tasks.filter((t) => dayKey(t.startedAt || now) === key);
    out.push({
      // 完整年月日，前端所有日期展示都带年份
    d: key,
      n: dayTasks.length,
      act: Math.round(dayTasks.reduce((s, t) => s + (t.activeMs || 0), 0) / 60000)
    });
  }
  return out;
}

export { SUMMARY_FILE, INDEX_FILE, FP_FILE, SCANS_FILE };
