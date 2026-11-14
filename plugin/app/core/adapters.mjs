// AgentCenter 内置适配器（11 个）
// 每个适配器声明默认路径与解析家族；解析只读，绝不写源目录（FR-SC-07）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { expandPath, exists, isDir, isFile, walkFiles, dirBytes, parseJsonl, openSqlite, clip, projectFromPath } from './util.mjs';

const APPDATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const LOCAL = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');

/** 统一适配器清单：id / 显示名 / 存储形态 / 三平台默认路径 / 解析家族 */
export const ADAPTERS = [
  {
    id: 'codebuddy', name: 'CodeBuddy', kind: 'SQLite',
    family: 'vscdb',
    base: {
      win: path.join(APPDATA, 'CodeBuddy CN'),
      mac: path.join(os.homedir(), 'Library', 'Application Support', 'CodeBuddy CN'),
      linux: path.join(os.homedir(), '.config', 'CodeBuddy CN')
    },
    paths: {
      win: [path.join(APPDATA, 'CodeBuddy CN', 'codebuddy-sessions.vscdb'), path.join(APPDATA, 'CodeBuddy', 'codebuddy-sessions.vscdb')],
      mac: [path.join(os.homedir(), 'Library', 'Application Support', 'CodeBuddy CN', 'codebuddy-sessions.vscdb')],
      linux: [path.join(os.homedir(), '.config', 'CodeBuddy CN', 'codebuddy-sessions.vscdb')]
    },
    // 中间文件目录（只统计，不删除）
    intermediates: [
      { sub: 'blob_storage', reason: '二进制缓存' },
      { sub: 'Cache', reason: '渲染缓存' },
      { sub: 'Code Cache', reason: '脚本缓存' },
      { sub: 'GPUCache', reason: 'GPU 缓存' },
      { sub: 'Backups', reason: '备份快照' }
    ]
  },
  {
    id: 'trae', name: 'Trae', kind: 'SQLite',
    family: 'vscdb',
    paths: {
      win: [path.join(APPDATA, 'Trae', 'User', 'globalStorage', 'state.vscdb'), path.join(LOCAL, 'Trae', 'User', 'globalStorage', 'state.vscdb')],
      mac: [path.join(os.homedir(), 'Library', 'Application Support', 'Trae', 'User', 'globalStorage', 'state.vscdb')],
      linux: [path.join(os.homedir(), '.config', 'Trae', 'User', 'globalStorage', 'state.vscdb')]
    },
    intermediates: [{ sub: 'User', reason: 'IDE 派生存储' }]
  },
  {
    // Qoder（阿里 Qoder CN）：会话在 ~/.qoder-cn/projects/<路径slug>/<sessionId>.jsonl
    // 行格式与 Claude Code 同源：type=user/assistant，message.content[] 含 text/thinking/tool_use/tool_result，
    // timestamp 为 ISO 字符串，顶层带 cwd / sessionId / isSidechain
    id: 'qoder', name: 'Qoder', kind: 'JSONL',
    family: 'qoder',
    base: {
      win: path.join(os.homedir(), '.qoder-cn'),
      mac: path.join(os.homedir(), '.qoder-cn'),
      linux: path.join(os.homedir(), '.qoder-cn')
    },
    paths: {
      win: [path.join(os.homedir(), '.qoder-cn', 'projects'), path.join(os.homedir(), '.qoder', 'projects')],
      mac: [path.join(os.homedir(), '.qoder-cn', 'projects'), path.join(os.homedir(), '.qoder', 'projects')],
      linux: [path.join(os.homedir(), '.qoder-cn', 'projects'), path.join(os.homedir(), '.qoder', 'projects')]
    },
    intermediates: [
      { sub: 'file-history', reason: '文件历史快照' },
      { sub: 'shell-snapshots', reason: 'Shell 快照' },
      { sub: 'logs', reason: '运行日志' },
      { sub: 'tmp', reason: '临时文件' },
      { sub: 'session-env', reason: '会话环境快照' }
    ]
  },
  {
    id: 'workbuddy', name: 'WorkBuddy', kind: 'JSONL',
    family: 'workbuddy',
    base: {
      win: path.join(os.homedir(), '.workbuddy'),
      mac: path.join(os.homedir(), '.workbuddy'),
      linux: path.join(os.homedir(), '.workbuddy')
    },
    paths: {
      win: [path.join(os.homedir(), '.workbuddy', 'projects')],
      mac: [path.join(os.homedir(), '.workbuddy', 'projects')],
      linux: [path.join(os.homedir(), '.workbuddy', 'projects')]
    },
    intermediates: [
      { sub: 'file-history', reason: '文件历史快照' },
      { sub: 'blobs', reason: '二进制产物' },
      { sub: 'clipboard-images', reason: '剪贴板图片' },
      { sub: 'artifact-index', reason: '产物索引' },
      { sub: 'changes-index', reason: '变更索引' },
      { sub: 'changes-detail', reason: '变更明细' }
    ]
  },
  {
    id: 'zcode', name: 'zcode', kind: 'JSONL',
    family: 'claude-jsonl',
    paths: {
      win: [path.join(os.homedir(), '.zcode', 'sessions'), path.join(APPDATA, 'zcode')],
      mac: [path.join(os.homedir(), '.zcode', 'sessions')],
      linux: [path.join(os.homedir(), '.zcode', 'sessions')]
    },
    intermediates: []
  },
  {
    id: 'opencode', name: 'OpenCode', kind: 'SQLite',
    family: 'opencode-db',
    paths: {
      win: [path.join(os.homedir(), '.local', 'share', 'opencode')],
      mac: [path.join(os.homedir(), '.local', 'share', 'opencode')],
      linux: [path.join(os.homedir(), '.local', 'share', 'opencode')]
    },
    intermediates: [
      { sub: 'tool-output', reason: '工具原始输出' },
      { sub: 'snapshot', reason: '文件快照' },
      { sub: 'log', reason: '运行日志' },
      { sub: 'repos', reason: '仓库缓存' }
    ]
  },
  {
    id: 'atomcode', name: 'AtomCode', kind: 'JSONL',
    family: 'atomcode',
    base: {
      win: path.join(os.homedir(), '.atomcode'),
      mac: path.join(os.homedir(), '.atomcode'),
      linux: path.join(os.homedir(), '.atomcode')
    },
    paths: {
      win: [path.join(os.homedir(), '.atomcode', 'sessions')],
      mac: [path.join(os.homedir(), '.atomcode', 'sessions')],
      linux: [path.join(os.homedir(), '.atomcode', 'sessions')]
    },
    intermediates: [
      { sub: 'file-history', reason: '文件历史' },
      { sub: 'image-cache', reason: '图片缓存' },
      { sub: 'datalog', reason: '事件日志' },
      { sub: 'staged', reason: '暂存区' }
    ]
  },
  {
    // DeepSeek Harness（DSH）：会话在 ~/.dsh/sessions/<项目slug>/session-<uuid>/session.jsonl.zstd
    // 存储为「多帧追加」的 zstd 压缩 JSONL，需要逐帧解压（见 util.mjs 的 decompressZstdFrames）
    // 显示名用产品全名，避免与 DeepSeek 模型名混淆
    id: 'deepseek', name: 'DeepSeek Harness', kind: 'zstd JSONL',
    family: 'dsh',
    base: {
      win: path.join(os.homedir(), '.dsh'),
      mac: path.join(os.homedir(), '.dsh'),
      linux: path.join(os.homedir(), '.dsh')
    },
    paths: {
      win: [path.join(os.homedir(), '.dsh', 'sessions')],
      mac: [path.join(os.homedir(), '.dsh', 'sessions')],
      linux: [path.join(os.homedir(), '.dsh', 'sessions')]
    },
    intermediates: [
      { sub: 'attachments', reason: '对话附件' },
      { sub: 'storages', reason: '存储缓存' },
      { sub: 'dsh-runtimes', reason: '运行时' }
    ]
  },
  {
    id: 'codex', name: 'Codex CLI', kind: 'JSONL',
    family: 'claude-jsonl',
    paths: {
      win: [path.join(os.homedir(), '.codex', 'sessions'), path.join(os.homedir(), '.codex', 'history.jsonl')],
      mac: [path.join(os.homedir(), '.codex', 'sessions')],
      linux: [path.join(os.homedir(), '.codex', 'sessions')]
    },
    intermediates: []
  },
  {
    id: 'claudecode', name: 'Claude Code', kind: 'JSONL',
    family: 'claude-jsonl',
    paths: {
      win: [path.join(os.homedir(), '.claude', 'projects')],
      mac: [path.join(os.homedir(), '.claude', 'projects')],
      linux: [path.join(os.homedir(), '.claude', 'projects')]
    },
    intermediates: [
      { sub: 'file-history', reason: '文件历史' },
      { sub: 'todos', reason: '待办缓存' }
    ]
  },
  {
    id: 'doubao', name: '豆包工作台', kind: 'Electron 存储',
    family: 'electron',
    paths: {
      win: [path.join(APPDATA, 'Bytedance', 'Doubao'), path.join(APPDATA, 'Doubao'), path.join(LOCAL, 'Doubao')],
      mac: [path.join(os.homedir(), 'Library', 'Application Support', 'Bytedance', 'Doubao')],
      linux: [path.join(os.homedir(), '.config', 'Bytedance', 'Doubao')]
    },
    intermediates: [{ sub: 'blob_storage', reason: '附件缓存' }]
  },
  {
    id: 'qwen', name: '千问工作台', kind: 'Electron 存储',
    family: 'electron',
    paths: {
      win: [path.join(APPDATA, 'Tongyi'), path.join(APPDATA, 'Tongyi', 'Qianwen')],
      mac: [path.join(os.homedir(), 'Library', 'Application Support', 'Tongyi')],
      linux: [path.join(os.homedir(), '.config', 'Tongyi')]
    },
    intermediates: [
      { sub: 'blob_storage', reason: '附件缓存' },
      { sub: 'Local Storage', reason: '站点存储' },
      { sub: 'Partitions', reason: '分区存储' }
    ]
  }
];

/** 按平台挑默认路径（win32 / darwin / 其它视为 linux） */
export function platformPaths(adapter) {
  const key = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux';
  return (adapter.paths[key] || []).map(expandPath);
}

/**
 * 适配器的「根目录」：中间文件/产物目录相对它计算。
 * 会话源可能是子目录（如 ~/.workbuddy/projects）或单文件（如 *.vscdb），
 * 但缓存目录都在上一级，因此单独声明 base。
 */
export function baseOf(adapter, detPath) {
  const key = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux';
  const declared = adapter.base && adapter.base[key];
  if (declared) return expandPath(declared);
  if (!detPath) return '';
  const st = exists(detPath);
  if (st && st.isFile()) return path.dirname(detPath);
  return detPath;
}

/** 探测：返回第一个存在的默认路径（自定义路径优先） */
export function detect(adapter, customPath) {
  if (customPath) {
    const p = expandPath(customPath);
    if (exists(p)) return { path: p, installed: true, custom: true };
    return { path: p, installed: false, custom: true };
  }
  for (const p of platformPaths(adapter)) if (exists(p)) return { path: p, installed: true, custom: false };
  return { path: platformPaths(adapter)[0] || '', installed: false, custom: false };
}

// ---------------------------------------------------------------- 会话枚举

const MAX_FILES = 4000;

/** 列出该适配器的会话源（不解析内容，只拿元信息，用于增量指纹） */
export async function listSessions(adapter, root) {
  if (!root || !exists(root)) return [];
  const fam = adapter.family;
  if (fam === 'workbuddy') {
    const out = [];
    for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const full = path.join(root, dir.name);
      let ents;
      try { ents = fs.readdirSync(full, { withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
        const f = path.join(full, e.name);
        let st;
        try { st = fs.statSync(f); } catch { continue; }
        out.push({
          sessionId: e.name.replace(/\.jsonl$/, ''), sourceFile: f,
          slug: dir.name, cwd: slugToPath(dir.name),
          mtimeMs: st.mtimeMs, bytes: st.size
        });
      }
    }
    return out.slice(0, MAX_FILES);
  }
  if (fam === 'atomcode') {
    const out = [];
    for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const full = path.join(root, dir.name);
      let ents;
      try { ents = fs.readdirSync(full, { withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
        const f = path.join(full, e.name);
        let st;
        try { st = fs.statSync(f); } catch { continue; }
        if (st.size === 0) continue; // 空会话文件不计入任务
        out.push({ sessionId: e.name.replace(/\.jsonl$/, ''), sourceFile: f, slug: dir.name, cwd: '', mtimeMs: st.mtimeMs, bytes: st.size });
      }
    }
    return out.slice(0, MAX_FILES);
  }
  if (fam === 'claude-jsonl' || fam === 'qoder') {
    // ~/.claude/projects/<slug>/*.jsonl、~/.codex/sessions/**.jsonl、~/.qoder-cn/projects/<slug>/*.jsonl
    const files = walkFiles(root, { maxFiles: MAX_FILES }).filter((f) => f.path.endsWith('.jsonl') || f.path.endsWith('history.jsonl'));
    return files.map((f) => ({
      sessionId: path.basename(f.path).replace(/\.jsonl$/, ''),
      sourceFile: f.path,
      slug: path.basename(path.dirname(f.path)),
      cwd: slugToPath(path.basename(path.dirname(f.path))),
      mtimeMs: f.mtimeMs, bytes: f.size
    }));
  }
  if (fam === 'dsh') {
    // 官方布局（见 deepseek-harness packages/session/session-persistence-jsonl/src/format.ts）：
    //   ~/.dsh/sessions/<项目slug>/<sessionId>/session[.vN].jsonl[.zstd]
    // 代际文件名规则（session-format/src/filename.ts）：
    //   v0 → session.jsonl；vN → session.vN.jsonl；压缩后追加 .zstd
    // 同一目录可能有多个代际，必须取「版本最高」的那一代（当前代际才是权威数据）。
    const out = [];
    for (const proj of fs.readdirSync(root, { withFileTypes: true })) {
      if (!proj.isDirectory() || proj.name.startsWith('.')) continue;
      const projDir = path.join(root, proj.name);
      let sessions = [];
      try { sessions = fs.readdirSync(projDir, { withFileTypes: true }); } catch { continue; }
      for (const s of sessions) {
        if (!s.isDirectory()) continue;
        const sessDir = path.join(projDir, s.name);
        let files = [];
        try { files = fs.readdirSync(sessDir); } catch { continue; }
        // 收集所有代际：session.jsonl(.zstd) / session.vN.jsonl(.zstd)
        let best = null;
        for (const name of files) {
          const m = /^session(?:\.v([1-9][0-9]*))?\.jsonl(\.zstd)?$/.exec(name);
          if (!m) continue;
          const version = m[1] === undefined ? 0 : Number(m[1]);
          const compressed = !!m[2];
          if (!best || version > best.version || (version === best.version && compressed)) {
            best = { version, name, compressed };
          }
        }
        if (!best) continue;
        const src = path.join(sessDir, best.name);
        const st = exists(src) || { mtimeMs: 0, size: 0 };
        // 官方 sessionId 是目录名本身（如 session-<uuid>）；也兼容裸 uuid 目录
        const dirName = s.name;
        const sessionId = dirName.replace(/^session-/, '');
        out.push({
          sessionId,
          sessionDirName: dirName,
          sourceFile: src,
          formatVersion: best.version,
          compressed: best.compressed,
          slug: proj.name,
          // 目录名 --E-Code-workspace-myproduct-service-- 里的 - 既是路径分隔符
          // 也是文件名中的连字符，无法无损还原；真实 cwd 从会话首行的 session.cwd 读取
          cwd: '',
          mtimeMs: st.mtimeMs, bytes: st.size,
          dshProject: true
        });
      }
    }
    return out.slice(0, MAX_FILES);
  }
  if (fam === 'opencode-db') {
    const dbFile = path.join(root, 'opencode.db');
    if (!isFile(dbFile)) return [];
    const db = await openSqlite(dbFile);
    if (!db) return [{ sessionId: 'opencode.db', sourceFile: dbFile, slug: 'opencode', cwd: '', mtimeMs: (exists(dbFile) || {}).mtimeMs || 0, bytes: (exists(dbFile) || {}).size || 0, unavailable: true }];
    let rows = [];
    try { rows = db.prepare('select id, slug, title, directory, time_created, time_updated from session').all(); } catch { rows = []; }
    try { db.close(); } catch {}
    const st = exists(dbFile) || { mtimeMs: 0, size: 0 };
    return rows.map((r) => ({
      sessionId: r.id, sourceFile: dbFile + '#session=' + r.id,
      slug: r.slug, cwd: r.directory || '', title: r.title,
      timeCreated: r.time_created, timeUpdated: r.time_updated,
      mtimeMs: st.mtimeMs, bytes: 0, dbFile
    }));
  }
  if (fam === 'vscdb') {
    const out = [];
    const db = await openSqlite(root);
    if (!db) return [{ sessionId: 'vscdb', sourceFile: root, slug: path.basename(path.dirname(root)), cwd: '', mtimeMs: (exists(root) || {}).mtimeMs || 0, bytes: (exists(root) || {}).size || 0, unavailable: true }];
    let rows = [];
    try { rows = db.prepare("select key, value from ItemTable where key like 'session:%'").all(); } catch { rows = []; }
    try { db.close(); } catch {}
    const st = exists(root) || { mtimeMs: 0, size: 0 };
    for (const r of rows) {
      let v = {};
      try { v = JSON.parse(r.value); } catch { continue; }
      const id = v.conversationId || String(r.key).replace(/^session:/, '');
      out.push({
        sessionId: id, sourceFile: root + '#session=' + id,
        slug: id, cwd: v.cwd || '', title: v.title || '',
        timeCreated: v.createdAt ? Date.parse(v.createdAt) || Number(v.createdAt) : 0,
        timeUpdated: v.updatedAt ? Date.parse(v.updatedAt) || Number(v.updatedAt) : 0,
        mtimeMs: st.mtimeMs, bytes: st.size, raw: v
      });
    }
    return out;
  }
  if (fam === 'electron') {
    // Electron 家族：不做逐条会话解析，按目录统计占用并给出一条汇总会话
    const st = exists(root) || { mtimeMs: 0, size: 0 };
    return [{ sessionId: path.basename(root), sourceFile: root, slug: path.basename(root), cwd: '', mtimeMs: st.mtimeMs, bytes: 0, electron: true }];
  }
  return [];
}

/** slug → 可能的物理路径（仅用于展示，不校验） */
export function slugToPath(slug) {
  if (!slug) return '';
  // D-Users-dev-WorkBuddy-2026-08-29-19-17-38 → D:\Users\dev\WorkBuddy\...
  const m = /^([A-Za-z])-(.*)$/.exec(slug);
  if (!m) return slug;
  const drive = m[1].toUpperCase() + ':';
  const rest = m[2].split('-').filter(Boolean);
  // 末尾形如 2026-08-29-19-17-38 的时间戳需要还原成一段
  const ts = [];
  while (rest.length && /^\d{2,4}$/.test(rest[rest.length - 1])) ts.unshift(rest.pop());
  const dirs = rest.concat(ts.length ? [ts.join('-')] : []);
  return drive + '\\' + dirs.join('\\');
}
