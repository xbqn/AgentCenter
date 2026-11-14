// AgentCenter 扫描内核 · 通用工具（零外部依赖）
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import * as zlib from 'node:zlib';

/* zstd 解压能力是 Node 22.15+ / 23.8+ 才有的（node:zlib.zstdDecompressSync）。
   早先这里是 `import { zstdDecompressSync } from 'node:zlib'`：在旧版 Node 上
   模块加载阶段就会抛 “does not provide an export named 'zstdDecompressSync'”，
   整个服务连启动都做不到。改成命名空间导入 + 运行时探测：
   缺这个能力时只让「DSH 的 zstd 会话」降级，其它 Agent 照常扫描。 */
const zstdDecompressSync = typeof zlib.zstdDecompressSync === 'function' ? zlib.zstdDecompressSync : null;
// 注意：zlib.zstdDecompress 是 callback 形式（asyncBufferWrapper(buffer, opts, callback)），
// 而且 promisify 对它不生效（返回 undefined 回调），这里显式包一层 Promise。
const zstdDecompressAsync = typeof zlib.zstdDecompress === 'function'
  ? (buffer, opts) => new Promise((resolve, reject) => {
      zlib.zstdDecompress(buffer, opts || {}, (error, result) => (error ? reject(error) : resolve(result)));
    })
  : null;
const ZSTD_e_flush = zlib.constants && typeof zlib.constants.ZSTD_e_flush === 'number' ? zlib.constants.ZSTD_e_flush : 2;

/** 当前 Node 是否支持 zstd 解压（DSH 的会话文件需要它）。 */
export const ZSTD_AVAILABLE = zstdDecompressSync !== null;

/** 给用户看的原因；可用时返回空串。 */
export function zstdUnavailableReason() {
  if (ZSTD_AVAILABLE) return '';
  return '当前 Node ' + process.versions.node + ' 不支持 zstd 解压（需要 22.15+ 或 23.8+），'
    + 'DeepSeek Harness 的 .zstd 会话会被跳过；升级 Node 后即可正常读取。';
}

/** 展开 ~ / %VAR% / ${VAR}，返回绝对路径 */
export function expandPath(p) {
  if (!p) return '';
  let s = String(p).trim();
  s = s.replace(/^~(?=$|[\\/])/, os.homedir());
  s = s.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, k) => process.env[k] || m);
  s = s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, k) => process.env[k] || m);
  return path.normalize(s);
}

export function exists(p) {
  try { return fs.statSync(p); } catch { return null; }
}

export function isDir(p) { const s = exists(p); return !!(s && s.isDirectory()); }
export function isFile(p) { const s = exists(p); return !!(s && s.isFile()); }

/** 递归列出目录下的文件（跳过符号链接，避免循环与跨盘统计） */
export function walkFiles(dir, opts = {}) {
  const out = [];
  const maxFiles = opts.maxFiles || Infinity;
  const stack = [dir];
  while (stack.length && out.length < maxFiles) {
    const cur = stack.pop();
    let ents;
    try { ents = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (out.length >= maxFiles) break;
      const full = path.join(cur, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { stack.push(full); continue; }
      if (!e.isFile()) continue;
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      out.push({ path: full, size: st.size, mtimeMs: st.mtimeMs });
    }
  }
  return out;
}

/** 递归统计目录占用（排除符号链接） */
export function dirBytes(dir, opts = {}) {
  let total = 0;
  for (const f of walkFiles(dir, opts)) total += f.size;
  return total;
}

/** 分块读大文件的最后 N 行，避免整文件进内存 */
export function readLines(file, limit = Infinity) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const lines = raw.split(/\r?\n/);
  const out = [];
  for (const l of lines) {
    if (!l) continue;
    out.push(l);
    if (out.length >= limit) break;
  }
  return out;
}

/** 逐行 JSON 解析，坏行计入 bad 而不抛出（FR-SC-06 单文件失败隔离） */
export function parseJsonl(file, limit = Infinity) {
  const rows = [];
  let bad = 0;
  for (const line of readLines(file, limit)) {
    try { rows.push(JSON.parse(line)); } catch { bad++; }
  }
  return { rows, bad };
}

/* zstd 帧魔数 0xFD2FB528，小端字节序为 28 B5 2F FD */
const ZSTD_MAGIC = 0xFD2FB528;

/**
 * 按 zstd 帧头/块头结构扫描帧边界。
 * 与官方 deepseek-harness 的 scanZstdFrames（session-persistence-jsonl/src/zstd.ts）同语义：
 *   - 不靠魔数猜测，而是逐帧读 frame header + block headers 得到精确边界
 *   - 遇到文件尾被截断的帧（tornStart）时返回已完成帧并标记，便于恢复已写入的明文
 * @returns {{frames:{start:number,end:number}[], tornStart?:number}}
 */
export function scanZstdFrames(buf, maxFrames = Infinity) {
  const frames = [];
  let offset = 0;
  while (offset < buf.length) {
    const start = offset;
    if (buf.length - offset < 4) return { frames, tornStart: start };
    if (buf.readUInt32LE(offset) !== ZSTD_MAGIC) {
      // 非规范帧：不静默跳过，交由调用方计入坏帧
      throw new Error('invalid zstd frame magic at byte ' + offset);
    }
    offset += 4;
    if (offset === buf.length) return { frames, tornStart: start };
    const descriptor = buf.readUInt8(offset);
    offset += 1;
    if ((descriptor & 0x18) !== 0) throw new Error('reserved zstd frame-header bit at byte ' + (offset - 1));
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 0x20) !== 0;
    const checksum = (descriptor & 0x04) !== 0;
    const dictionaryFlag = descriptor & 0x03;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buf.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buf.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buf.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 0x03;
      const blockSize = blockHeader >>> 3;
      if (blockType === 0x03) throw new Error('reserved zstd block type at byte ' + (offset - 3));
      const payloadBytes = blockType === 0x01 ? 1 : blockSize;
      if (buf.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buf.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
    if (frames.length === maxFrames) return { frames };
  }
  return { frames };
}

/**
 * 解压「多帧追加」的 zstd 文件（DeepSeek Harness 的 session[.vN].jsonl.zstd 即此格式）。
 * 这种文件是每次追加写入时各压一帧、再把帧顺序拼接起来，因此：
 *   - zstdDecompressSync(整个文件) 只能得到第一帧（实测 217 字节 vs 压缩后 2.2 MB）
 *   - 流式解压同样在第一个帧结束后就停止
 * 正确做法是按官方 scanZstdFrames 的结构化扫描得到精确边界，再逐帧解压拼接；
 * 末尾被截断的帧用 ZSTD_e_flush 尽量恢复已写入的明文。
 */
export function decompressZstdFrames(file, opts = {}) {
  let buf;
  try { buf = fs.readFileSync(file); } catch { return { text: '', frames: 0, bad: 0, torn: false }; }
  // 旧版 Node 没有 zstd：不抛错，交回空文本 + 原因，由调用方标记为「不可读」而不是崩溃
  if (!ZSTD_AVAILABLE) {
    return { text: '', frames: 0, bad: 0, torn: false, unavailable: true, reason: zstdUnavailableReason() };
  }
  let scan;
  try {
    scan = scanZstdFrames(buf);
  } catch (e) {
    // 结构损坏：退回逐字节找魔数，尽量抢救可读帧
    const starts = [];
    for (let i = 0; i + 4 <= buf.length; i++) {
      if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) starts.push(i);
    }
    scan = { frames: starts.map((s, k) => ({ start: s, end: k + 1 < starts.length ? starts[k + 1] : buf.length })) };
  }
  const parts = [];
  let bad = 0;
  for (const f of scan.frames) {
    try { parts.push(zstdDecompressSync(buf.subarray(f.start, f.end))); } catch { bad++; }
  }
  // 残缺尾帧：用 flush 模式尽力恢复（官方 decompressZstdPrefix 的做法）
  let torn = false;
  if (scan.tornStart !== undefined && scan.tornStart < buf.length) {
    torn = true;
    try {
      const tail = zstdDecompressSync(buf.subarray(scan.tornStart), { finishFlush: ZSTD_e_flush });
      if (tail && tail.length) parts.push(tail);
    } catch { bad++; }
  }
  return { text: Buffer.concat(parts).toString('utf8'), frames: scan.frames.length, bad, torn };
}

/* 解压结果按「文件 + mtime + size」缓存：会话文件不变就不重复解压。
   深搜会反复扫同一批任务，缓存能把第二轮之后的成本压到接近零。 */
const ZSTD_CACHE = new Map();
const ZSTD_CACHE_MAX = 24;

function cacheKeyOf(file, stat) {
  return file + '|' + Math.round(stat.mtimeMs) + '|' + stat.size;
}

function rememberInCache(key, value) {
  if (ZSTD_CACHE.size >= ZSTD_CACHE_MAX) {
    // 简单 FIFO：删最早插入的一条
    const first = ZSTD_CACHE.keys().next();
    if (!first.done) ZSTD_CACHE.delete(first.value);
  }
  ZSTD_CACHE.set(key, value);
}

/**
 * 异步版：与 decompressZstdFrames 语义一致，但用 zstdDecompress（线程池）逐帧解压，
 * 不会阻塞事件循环——深搜时多个任务才能真正并行。
 * @param {string} file
 * @returns {Promise<{text:string, frames:number, bad:number, torn:boolean, cached?:boolean}>}
 */
/**
 * 文件原文里是否出现关键词（大小写不敏感）。
 * 用来在解析前淘汰绝大多数无关会话：读一遍原始字节比 JSON.parse 全部行便宜一个数量级。
 * zstd 文件先解压（有缓存），再在解压文本里找。
 * @param {string} file
 * @param {string} needle - 已小写
 * @param {{zstd?:boolean}} opts
 * @returns {Promise<boolean>}
 */
export async function fileMayContain(file, needle, opts = {}) {
  const q = String(needle || '').toLowerCase();
  if (q === '') return false;
  if (opts.zstd === true) {
    const z = await decompressZstdFramesAsync(file);
    if (!z.text) return false;
    return z.text.toLowerCase().includes(q);
  }
  // 异步读：多个任务并行时才真的并行（readFileSync 会串行阻塞事件循环）
  let buf;
  try { buf = await fsp.readFile(file); } catch { return false; }
  return buf.toString('utf8').toLowerCase().includes(q);
}

export async function decompressZstdFramesAsync(file) {
  let stat;
  try { stat = fs.statSync(file); } catch { return { text: '', frames: 0, bad: 0, torn: false }; }
  const key = cacheKeyOf(file, stat);
  const cached = ZSTD_CACHE.get(key);
  if (cached !== undefined) return { ...cached, cached: true };
  if (!ZSTD_AVAILABLE) {
    return { text: '', frames: 0, bad: 0, torn: false, unavailable: true, reason: zstdUnavailableReason() };
  }
  if (zstdDecompressAsync === null) {
    // 极老的 22.15~ 早期版本只有同步版：退化为同步，至少保证正确
    const sync = decompressZstdFrames(file);
    if (sync.text) rememberInCache(key, sync);
    return sync;
  }

  let buf;
  try { buf = fs.readFileSync(file); } catch { return { text: '', frames: 0, bad: 0, torn: false }; }
  let scan;
  try {
    scan = scanZstdFrames(buf);
  } catch {
    const starts = [];
    for (let i = 0; i + 4 <= buf.length; i++) {
      if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) starts.push(i);
    }
    scan = { frames: starts.map((s, k) => ({ start: s, end: k + 1 < starts.length ? starts[k + 1] : buf.length })) };
  }

  const parts = [];
  let bad = 0;
  for (const f of scan.frames) {
    try { parts.push(await zstdDecompressAsync(buf.subarray(f.start, f.end))); } catch { bad++; }
  }
  let torn = false;
  if (scan.tornStart !== undefined && scan.tornStart < buf.length) {
    torn = true;
    try {
      const tail = await zstdDecompressAsync(buf.subarray(scan.tornStart), { finishFlush: ZSTD_e_flush });
      if (tail && tail.length) parts.push(tail);
    } catch { bad++; }
  }
  const out = { text: Buffer.concat(parts).toString('utf8'), frames: scan.frames.length, bad, torn };
  if (out.text) rememberInCache(key, out);
  return out;
}

/** 只读 SQLite 打开；不可用时返回 null，由调用方降级 */
export async function openSqlite(file) {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    return new DatabaseSync(file, { readOnly: true });
  } catch { return null; }
}

/** epoch ms → 本地 HH:mm */
export function hhmm(ms) {
  if (!ms) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

/** epoch ms → 本地 ISO 8601（带时区偏移） */
export function isoLocal(ms) {
  if (!ms) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const oh = String(Math.floor(Math.abs(off) / 60)).padStart(2, '0');
  const om = String(Math.abs(off) % 60).padStart(2, '0');
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) +
    sign + oh + ':' + om;
}

export function dayKey(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

/** 原子写：先写临时文件再改名，避免半截 JSON */
/** 原子写纯文本（先写 .tmp 再 rename）；大文件也适用。 */
export function writeTextAtomic(file, text) {
  const tmp = file + '.tmp-' + process.pid;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
  return file;
}
export function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

/** 从路径 slug 还原可读项目名：D-Users-dev-WorkBuddy-... → 取首段盘符 + 目录 */
export function projectFromPath(p) {
  if (!p) return '—';
  const norm = p.replace(/[\\/]+$/, '');
  const parts = norm.split(/[\\/]+/).filter(Boolean);
  if (!parts.length) return '—';
  const base = parts[parts.length - 1];
  return base || '—';
}

/** 截断文本，按字符计（中文按 1 字） */
export function clip(s, n) {
  if (!s) return '';
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : t.slice(0, n - 1) + '…';
}

export function nowMs() { return Date.now(); }
