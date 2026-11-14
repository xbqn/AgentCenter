// On-demand segmented full-text index for deep search.
//
// Design: one JSON file per task under <dataDir>/search/, holding the flattened
// conversation lines. Built lazily by the first search, refreshed only when that
// task's source file changed (mtime+size). Nothing runs during scan, so scanning
// keeps its old cost.
import fs from 'node:fs';
import path from 'node:path';
import { SEARCH_DIR } from './scan.mjs';
import { conversationIndexLines } from './conversation.mjs';
import { writeTextAtomic } from './util.mjs';

/** 安全文件名：taskId 里有冒号、@、空格、中文，统一收敛。 */
function fileNameOf(taskId) {
  return String(taskId).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) + '.txt';
}

function stampOf(task) {
  const file = String(task.sourceFile || task.src || '').split('#')[0];
  try {
    const st = fs.statSync(file);
    return Math.round(st.mtimeMs) + ':' + st.size;
  } catch {
    return '0:0';
  }
}

/**
 * 取一个任务的正文索引行；缺失或过期时重建。
 * @param {string} dataDir
 * @param {object} task
 * @returns {Promise<string[]>}
 */
export async function linesOfTask(dataDir, task) {
  const taskId = String(task.taskId || task.id || '');
  if (taskId === '') return [];
  const dir = SEARCH_DIR(dataDir);
  const file = path.join(dir, fileNameOf(taskId));
  const stamp = stampOf(task);
  try {
    const head = fs.readFileSync(file, 'utf8');
    const nl = head.indexOf('\n');
    if (nl > 0 && head.slice(0, nl) === '#stamp ' + stamp) {
      return head.slice(nl + 1).split('\n').filter((l) => l !== '');
    }
  } catch {
    /* 还没有索引 */
  }
  const r = await conversationIndexLines(task, {});
  if (!r.ok) return [];
  const lines = r.lines || [];
  try {
    fs.mkdirSync(dir, { recursive: true });
    writeTextAtomic(file, '#stamp ' + stamp + '\n' + (lines.length ? lines.join('\n') + '\n' : ''));
  } catch {
    /* 写不进去就只服务本次 */
  }
  return lines;
}

/**
 * 在一批任务里搜关键词，返回命中摘要。
 * @param {string} dataDir
 * @param {object[]} tasks
 * @param {string} needle 已小写
 * @param {{includeThink?:boolean, includeTool?:boolean, maxHits?:number, limit?:number, budgetMs?:number}} opts
 */
/**
 * 把全部分片合并成一个文件（`search/all.txt`），并记录分片状态。
 *
 * 每次搜索都读 515 个分片文件要 5 秒左右（文件系统开销），合并成一个文件后是毫秒级。
 * 只有分片集合发生变化（新增/重建）时才重新合并，所以日常搜索不会反复付出这个成本。
 * @param {string} dataDir
 * @returns {Promise<{file:string, fresh:boolean}>}
 */
const SEG_HEAD = '#seg ';
/** 合并文件的压紧阈值：失效块超过存活块的一半（或超过 8 MB）就整体重写一次。 */
const COMPACT_RATIO = 0.5;
const COMPACT_BYTES = 8 * 1024 * 1024;

/** 读合并文件，拆成 name → { sig, body } 的块表；返回 legacy=true 表示是没有块头的旧格式。 */
function readBundleBlocks(bundle) {
  let raw = '';
  try { raw = fs.readFileSync(bundle, 'utf8'); } catch { return { blocks: new Map(), legacy: false }; }
  if (raw === '') return { blocks: new Map(), legacy: false };
  const blocks = new Map();
  let cur = null;
  let buf = [];
  const flush = () => {
    if (cur !== null) blocks.set(cur.name, { sig: cur.sig, body: buf.join('\n') });
  };
  for (const line of raw.split('\n')) {
    if (line.startsWith(SEG_HEAD)) {
      flush();
      const rest = line.slice(SEG_HEAD.length);
      const cut = rest.lastIndexOf('|');
      cur = cut > 0 ? { name: rest.slice(0, cut), sig: rest.slice(cut + 1) } : null;
      buf = [];
    } else if (cur !== null) {
      buf.push(line);
    }
  }
  flush();
  // 一个块头都没有 → 旧版「整份拼接」格式，必须整体重写一次
  return { blocks, legacy: blocks.size === 0 };
}

/**
 * 把分片汇总成一份可搜索的文本。
 *
 * 之前每次有分片变化就整体重写 20 MB；现在改成**只追加变化的块**：
 * 合并文件是一个带 `#seg <name>|<sig>` 头的块日志，签名与当前分片一致就复用，
 * 不一致或缺失的块追加到文件末尾。失效块累积到阈值时才整体压紧一次。
 *
 * @param {string} dataDir
 * @param {string[]} segments 当前存在的分片文件名
 * @returns {{byName: Map<string, string>, appended: number, compacted: boolean}}
 */
function bundleIndex(dataDir, segments) {
  const dir = SEARCH_DIR(dataDir);
  const bundle = path.join(dir, 'all.txt');

  // 当前分片的签名（文件名 → size:mtime）
  const liveSig = new Map();
  for (const name of segments) {
    try {
      const st = fs.statSync(path.join(dir, name));
      liveSig.set(name, st.size + ':' + Math.round(st.mtimeMs));
    } catch {
      /* 跳过消失的分片 */
    }
  }

  const parsed = readBundleBlocks(bundle);
  const blocks = parsed.blocks;
  const byName = new Map();
  let liveBytes = 0;
  let staleBytes = 0;
  for (const [name, block] of blocks) {
    if (liveSig.get(name) === block.sig) {
      byName.set(name, block.body);
      liveBytes += block.body.length;
    } else {
      staleBytes += block.body.length;
    }
  }

  // 缺失/过期的分片：读出来准备追加
  const pending = [];
  for (const [name, sig] of liveSig) {
    if (byName.has(name)) continue;
    let body;
    try {
      const raw = fs.readFileSync(path.join(dir, name), 'utf8');
      const nl = raw.indexOf('\n');
      body = nl > 0 ? raw.slice(nl + 1) : '';
    } catch {
      continue;
    }
    pending.push({ name, sig, body });
    byName.set(name, body);
  }

  const needCompact = parsed.legacy || staleBytes > COMPACT_BYTES || (liveBytes > 0 && staleBytes > liveBytes * COMPACT_RATIO);

  try {
    fs.mkdirSync(dir, { recursive: true });
    if (needCompact) {
      // 整体压紧：只写当前有效的块
      const parts = [];
      for (const [name, sig] of liveSig) {
        const body = byName.get(name);
        if (body === undefined) continue;
        parts.push(SEG_HEAD + name + '|' + sig + '\n' + (body.endsWith('\n') || body === '' ? body : body + '\n'));
      }
      writeTextAtomic(bundle, parts.join(''));
      return { byName, appended: 0, compacted: true };
    }
    if (pending.length > 0) {
      const parts = [];
      for (const item of pending) {
        parts.push(SEG_HEAD + item.name + '|' + item.sig + '\n' + (item.body.endsWith('\n') || item.body === '' ? item.body : item.body + '\n'));
      }
      fs.appendFileSync(bundle, parts.join(''), 'utf8');
    }
    return { byName, appended: pending.length, compacted: false };
  } catch {
    return { byName, appended: 0, compacted: false };
  }
}

/**
 * 清理已不在索引里的任务分片（会话被删、换了数据目录、任务合并等）。
 * 只删 `<taskId>.txt` 分片，不动 all.txt；返回删除数量。
 * @param {string} dataDir
 * @param {Set<string>} wantedIds 当前索引里的 taskId 集合
 * @returns {number}
 */
function pruneSegments(dataDir, wantedIds) {
  const dir = SEARCH_DIR(dataDir);
  const keep = new Set();
  for (const id of wantedIds) keep.add(fileNameOf(id));
  let removed = 0;
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return 0; }
  for (const name of names) {
    if (!name.endsWith('.txt') || name === 'all.txt') continue;
    if (keep.has(name)) continue;
    try { fs.unlinkSync(path.join(dir, name)); removed += 1; } catch { /* 删不掉就留着 */ }
  }
  return removed;
}

export async function searchTasks(dataDir, tasks, needle, opts = {}) {
  const q = String(needle || '').toLowerCase();
  const includeThink = opts.includeThink === true;
  const includeTool = opts.includeTool === true;
  const maxHits = Math.min(Number(opts.maxHits) || 5, 20);
  const limit = Math.min(Number(opts.limit) || 60, 200);
  const budget = Number(opts.budgetMs) || 25000;

  const allow = new Set(['user', 'assistant']);
  if (includeThink) allow.add('think');
  if (includeTool) { allow.add('tool'); allow.add('result'); }
  const labels = { user: '用户', assistant: '助手', think: '思考', tool: '工具调用', result: '工具结果' };

  const started = Date.now();
  const results = [];
  let scanned = 0;
  let truncated = false;

  // 1) 懒建：只补还没建/已过期的分片（首次搜索会慢，之后是 0 成本）
  let buildStopped = false;
  for (const task of tasks) {
    if (Date.now() - started > budget) { buildStopped = true; break; }
    try { await linesOfTask(dataDir, task); } catch { /* 单条失败跳过 */ }
  }
  // 只有真的没建完才算截断；分片都在时这里不会误报
  if (buildStopped) truncated = true;

  const wanted = new Set(tasks.map((t) => String(t.taskId || t.id || '')));

  // 2) 汇总分片（只追加变化的块），并清理已不在索引里的分片
  let segments = [];
  try { segments = fs.readdirSync(SEARCH_DIR(dataDir)).filter((n) => n.endsWith('.txt') && n !== 'all.txt').sort(); } catch { segments = []; }
  const pruned = pruneSegments(dataDir, wanted);
  if (pruned > 0) {
    try { segments = fs.readdirSync(SEARCH_DIR(dataDir)).filter((n) => n.endsWith('.txt') && n !== 'all.txt').sort(); } catch { /* 保持原样 */ }
  }
  const bundled = bundleIndex(dataDir, segments);
  const rowById = new Map();

  for (const [name, body] of bundled.byName) {
    if (body === '') continue;
    for (const line of body.split('\n')) {
    if (line === '') continue;
    const tab1 = line.indexOf('\t');
    if (tab1 < 0) continue;
    const taskId = line.slice(0, tab1);
    if (!wanted.has(taskId)) continue;
    if (line.toLowerCase().indexOf(q) === -1) continue;
    const tab2 = line.indexOf('\t', tab1 + 1);
    const tab3 = line.indexOf('\t', tab2 + 1);
    if (tab2 < 0 || tab3 < 0) continue;
    const role = line.slice(tab1 + 1, tab2);
    if (!allow.has(role)) continue;
    let row = rowById.get(taskId);
    if (row === undefined) { row = { total: 0, hits: [] }; rowById.set(taskId, row); }
    row.total += 1;
    if (row.hits.length >= maxHits) continue;
    const time = line.slice(tab2 + 1, tab3);
    const body = line.slice(tab3 + 1);
    const at = body.toLowerCase().indexOf(q);
    const from = Math.max(0, at - 60);
    const to = Math.min(body.length, at + q.length + 60);
    row.hits.push({
      role,
      roleLabel: labels[role] || role,
      time: time || '—',
      snippet: (from > 0 ? '…' : '') + body.slice(from, to) + (to < body.length ? '…' : ''),
    });
    }
  }

  for (const task of tasks) {
    const taskId = String(task.taskId || task.id || '');
    const row = rowById.get(taskId);
    scanned += 1;
    if (row === undefined) continue;
    results.push({ task, total: row.total, hits: row.hits });
    if (results.length >= limit) { truncated = true; break; }
  }


  return { ok: true, scanned, truncated, ms: Date.now() - started, results };
}

/**
 * 后台预热：把还没有索引的任务逐条建好（不阻塞调用方）。
 * 首次搜索会很慢（要抽一遍正文），预热之后就是毫秒级。
 * @param {string} dataDir
 * @param {object[]} tasks
 * @returns {{stop:()=>void, done:Promise<{built:number}>}}
 */
export function warmIndex(dataDir, tasks) {
  let stopped = false;
  const done = (async () => {
    let built = 0;
    for (const task of tasks) {
      if (stopped) break;
      try {
        const before = await linesOfTask(dataDir, task);
        if (before.length >= 0) built += 1;
      } catch {
        /* 单条失败跳过 */
      }
      await new Promise((resolve) => setTimeout(resolve, 0));   // 让出事件循环
    }
    return { built };
  })();
  return { stop() { stopped = true; }, done };
}