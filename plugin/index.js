/**
 * Host half of the AgentCenter bundle.
 *
 * It owns the AgentCenter H5 service lifecycle and exposes it to the page over
 * authenticated Fetch routes on the `/api` channel:
 *
 *   GET  /api/agentcenter/status      probe the service (running? port, url, index?)
 *   POST /api/agentcenter/start       host `h5/serve.mjs` in this process and wait until it answers
 *   POST /api/agentcenter/stop        close the server this Host started
 *   GET  /api/agentcenter/config      row config as the page reads it (`showInMore` gating the More entry)
 *   GET  /api/agentcenter/sessions    task list from `data/summary.json`, filtered by `q`
 *   GET  /api/agentcenter/transcript  one task's read-only markdown transcript
 *   POST /api/agentcenter/continue    how to continue a task (open its DSH Session, or import the transcript)
 *   GET  /api/agentcenter/links       `data/links.json` — AgentCenter task → DSH Session links
 *   POST /api/agentcenter/link        record one link (atomic write, never drops other entries)
 *
 * The service itself is the project's own zero-dependency server, and it binds
 * 127.0.0.1 only. The plugin keeps its index, links and exports in a user-level
 * data directory (default `~/.agentcenter`, overridable with the `dataDir` config),
 * never inside the installed package.
 */
import fs from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 7788;
const ROUTE = '/api/agentcenter';

/** The in-process server this Host hosts; reload keeps it, and a stale one is reported as unmanaged. */
const service = { app: null, startedAt: 0, error: '' };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** 数据目录：索引、日报、引用导出与关联表都放这里，不写进安装目录。 */
let DATA_DIR = '';

/** Resolve the bundled app: the configured root (advanced, a checkout), else `plugin/app`. */
function resolveRoot(config) {
  const configured = typeof config?.root === 'string' && config.root.trim() !== '' ? path.resolve(config.root) : null;
  if (configured !== null && fs.existsSync(path.join(configured, 'h5', 'serve.mjs'))) return configured;
  // 包自带一份运行时：h5/ + core/ + docs/解析规则/
  const bundled = path.join(HERE, 'app');
  if (fs.existsSync(path.join(bundled, 'h5', 'serve.mjs'))) return bundled;
  // 开发期直接指向仓库（本包位于 <repo>/plugin）时再往上找一层
  let dir = HERE;
  for (let depth = 0; depth < 4; depth += 1) {
    if (fs.existsSync(path.join(dir, 'h5', 'serve.mjs'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return configured ?? bundled;
}

/** 首次使用时把老版本留在仓库 data/ 里的用户状态搬过来（索引类可重建，不搬）。 */
async function ensureDataDir(root) {
  await mkdir(DATA_DIR, { recursive: true });
  const marker = path.join(DATA_DIR, '.migrated');
  if (fs.existsSync(marker)) return;
  // 老数据可能在包内 app/data（开发期直接指仓库时），也可能在仓库根的 data/
  const candidates = [path.join(root, 'data'), path.join(HERE, '..', 'data')];
  const legacy = candidates.find((dir) => fs.existsSync(dir) && path.resolve(dir) !== path.resolve(DATA_DIR));
  try {
    if (legacy !== undefined) {
      for (const name of ['links.json', 'overrides.json', 'config.json']) {
        const from = path.join(legacy, name);
        const to = path.join(DATA_DIR, name);
        if (fs.existsSync(from) && !fs.existsSync(to)) {
          try {
            await writeFile(to, await readFile(from));
          } catch {
            /* 单个文件搬不动就跳过 */
          }
        }
      }
      const reportsFrom = path.join(legacy, '日报');
      const reportsTo = path.join(DATA_DIR, '日报');
      if (fs.existsSync(reportsFrom)) {
        await mkdir(reportsTo, { recursive: true });
        for (const name of fs.readdirSync(reportsFrom)) {
          if (!name.endsWith('.md')) continue;
          const to = path.join(reportsTo, name);
          if (fs.existsSync(to)) continue;
          try {
            await writeFile(to, await readFile(path.join(reportsFrom, name)));
          } catch {
            /* 跳过写不动的文件 */
          }
        }
      }
    }
    await writeFile(marker, `migrated from ${legacy} at ${new Date().toISOString()}\n`, 'utf8');
  } catch {
    /* 迁移是尽力而为，失败也不影响使用 */
  }
}

/** 数据目录：配置优先；默认 `~/.agentcenter`（升级插件不会动它）。 */
function resolveDataDir(config) {
  const configured = typeof config?.dataDir === 'string' ? config.dataDir.trim() : '';
  if (configured !== '') {
    const expanded = configured === '~' || configured.startsWith('~/') || configured.startsWith('~\\')
      ? path.join(os.homedir(), configured.slice(1))
      : configured;
    return path.resolve(expanded);
  }
  return path.join(os.homedir(), '.agentcenter');
}

function resolvePort(config) {
  const port = Number(config?.port);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT;
}

/** Read `/api/health` from the local service; null when nothing answers. */
async function probe(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(1500),
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return null;
    const body = await response.json();
    return body && body.ok === true ? body : null;
  } catch {
    return null;
  }
}

/** True while this Host process itself is serving the page. */
function hosted() {
  return service.app !== null && service.app.listening === true;
}

/**
 * 本进程里绑在这个端口上的监听。
 * 插件重载后，上一实例的 http 服务可能还在听着（句柄已不可达），停用它只能从这里找回来；
 * 别的进程占着同一端口时这里返回 null，绝不会误关别人的服务。
 */
function findLocalServer(port) {
  const handles = typeof process._getActiveHandles === 'function' ? process._getActiveHandles() : [];
  for (const handle of handles) {
    try {
      if (handle === null || typeof handle !== 'object') continue;
      if (handle.listening !== true || typeof handle.address !== 'function' || typeof handle.close !== 'function') continue;
      const address = handle.address();
      if (address !== null && typeof address === 'object' && address.port === port) return handle;
    } catch {
      /* 有的句柄不可检视，跳过 */
    }
  }
  return null;
}

async function describe(root, port) {
  const health = await probe(port);
  const servePath = path.join(root, 'h5', 'serve.mjs');
  const dataFile = path.join(DATA_DIR, 'summary.json');
  return {
    ok: true,
    running: health !== null,
    managed: hosted(),
    pid: hosted() ? process.pid : 0,
    port,
    url: `http://127.0.0.1:${port}/`,
    root,
    dataDir: DATA_DIR,
    servePath,
    serveExists: fs.existsSync(servePath),
    hasIndex: fs.existsSync(dataFile),
    mode: health === null ? null : health.mode ?? null,
    uptimeMs: health === null ? null : health.uptimeMs ?? null,
    health,
    error: service.error || null,
  };
}

/**
 * Start the page the plugin shows — inside this Host process.
 *
 * `h5/serve.mjs` exports `createAgentCenterServer`, so the panel serves the real
 * UI without spawning anything: no child process, no external node binary, and
 * no browser window (`h5/start-h5.cmd` keeps that behaviour for the standalone
 * product). An instance already answering on the port — the standalone script,
 * or one left from an earlier run — is reused as-is.
 */
async function start(root, port) {
  const servePath = path.join(root, 'h5', 'serve.mjs');
  if (!fs.existsSync(servePath)) throw new Error(`未找到 AgentCenter 服务脚本：${servePath}`);
  if (hosted()) return;
  if ((await probe(port)) !== null) return;
  const module = await import(pathToFileURL(servePath).href);
  if (typeof module.createAgentCenterServer !== 'function') {
    throw new Error(`${servePath} 没有导出 createAgentCenterServer（旧版服务脚本？）`);
  }
  const app = module.createAgentCenterServer({ port, host: '127.0.0.1', dataDir: DATA_DIR });
  try {
    await app.listen();
  } catch (error) {
    throw new Error(
      error?.code === 'EADDRINUSE'
        ? `端口 ${port} 已被占用，但它没有响应 AgentCenter 的健康检查`
        : `服务启动失败：${messageOf(error)}`,
    );
  }
  service.app = app;
  service.startedAt = Date.now();
  service.error = '';
}

async function stop(port) {
  if (!hosted()) {
    if ((await probe(port)) === null) return;
    // 端口上还有 AgentCenter 在应答，但不是本实例托管的：
    // 同一进程里能拿回句柄（重载前的实例）就关掉，别的进程就明确拒绝。
    const local = findLocalServer(port);
    if (local !== null) {
      await new Promise((resolve) => {
        try {
          local.close(() => resolve());
        } catch {
          resolve();
        }
      });
      if ((await probe(port)) === null) return;
    }
    throw new Error('这个 AgentCenter 实例不是由插件当前实例托管的（可能来自 h5\\start-h5.cmd 或早先的进程），请先停掉它。');
  }
  const app = service.app;
  service.app = null;
  await app.close();
}

/** Read a JSON body defensively; every route here accepts an empty body. */
async function body(request) {
  try {
    const text = await request.text();
    if (!text) return {};
    const parsed = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

/* ------------------------------------------------------- 索引与对话（只读） */

const TRANSCRIPT_CHARS = 18000;   // 回放默认长度
const TRANSCRIPT_MAX_CHARS = 60000; // 回放上限
const TRANSCRIPT_TURNS = 600;     // 一次回放最多节点数
const SESSION_LIMIT = 40;         // 会话列表默认条数
const SESSION_MAX_LIMIT = 200;    // 会话列表上限

/** Error → message，供各路由的 `{ ok: false, error }` 回答用。 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/** 取一个查询参数；URL 不可解析时返回 ''。 */
function param(request, name) {
  try {
    return new URL(request.url).searchParams.get(name) ?? '';
  } catch {
    return '';
  }
}

/** 正整数参数，超过 `max` 时截到 `max`；非法值用 `fallback`。 */
function intParam(value, fallback, max) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

/** 索引文档里的任务数组：`{ ok, data: { tasks } }` 与裸对象两种形态都认。 */
function tasksOf(doc) {
  if (doc === null || typeof doc !== 'object') return [];
  const inner = doc.data;
  if (inner !== null && typeof inner === 'object' && Array.isArray(inner.tasks)) return inner.tasks;
  return Array.isArray(doc.tasks) ? doc.tasks : [];
}

/** 读 `<root>/data/<name>` 的任务数组；文件缺失、读不动、JSON 坏掉都当空列表。 */
async function readTasks(root, name) {
  try {
    return tasksOf(JSON.parse(await readFile(path.join(DATA_DIR, name), 'utf8')));
  } catch {
    return [];
  }
}

/** 按 taskId 找一条任务记录：先 `data/index.json`（带 sourceFile），再 `data/summary.json`。 */
async function taskRecord(root, taskId) {
  const wanted = typeof taskId === 'string' ? taskId.trim() : '';
  if (wanted === '') return null;
  for (const name of ['index.json', 'summary.json']) {
    const hit = (await readTasks(root, name)).find((task) => task && (task.taskId === wanted || task.id === wanted));
    if (hit !== undefined && hit !== null) return hit;
  }
  return null;
}

/** 任务 id（索引叫 taskId，摘要叫 id）。 */
function taskIdOf(task) {
  return String(task?.taskId ?? task?.id ?? '');
}

/** 时间戳 → 毫秒；数字与 ISO 串都认，不可用时 0。 */
function millisOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

/** 时间戳 → HH:MM；不可用时 ''。 */
function hhmmOf(value) {
  const ms = millisOf(value);
  if (ms === 0) return '';
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** 本地日期（YYYY-MM-DD），用于日报默认日期。 */
function todayOf() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** `起–止`：摘要记录自带 start/end，索引记录只有时间戳。 */
function timeRange(task) {
  if (typeof task?.start === 'string' && typeof task?.end === 'string' && task.start !== '') return `${task.start}–${task.end}`;
  const start = hhmmOf(task?.startedAt);
  const end = hhmmOf(task?.endedAt);
  if (start !== '' && end !== '') return `${start}–${end}`;
  return start || end || '';
}

/** 计数字段：摘要与索引各用一套名字，缺一个就用另一个，都没有算 0。 */
function countOf(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** 一条会话条目（路由 2 的 items[]）。 */
function sessionItem(task) {
  return {
    id: taskIdOf(task),
    agentId: String(task.agentId ?? ''),
    agentName: String(task.agentName ?? task.agent ?? ''),
    sessionId: String(task.sessionId ?? ''),
    title: String(task.title ?? ''),
    project: String(task.project ?? ''),
    dir: String(task.dir ?? task.cwd ?? ''),
    end: String(task.end ?? ''),
    startedAt: task.startedAt ?? null,
    status: String(task.status ?? ''),
    messages: countOf(task.messages ?? task.messageCount),
    toolCalls: countOf(task.toolCalls ?? task.toolCallCount),
    bytes: countOf(task.bytes ?? task.storageBytes),
  };
}

/** 事件角色 → markdown 里的粗体行。 */
function roleLabel(event) {
  const tool = typeof event?.tool === 'string' ? event.tool.trim() : '';
  switch (event?.role) {
    case 'user': return '用户';
    case 'assistant': return '助手';
    case 'think': return '思考';
    case 'tool': return tool === '' ? '工具调用' : `工具调用 · ${tool}`;
    case 'result': return '工具结果';
    case 'todo': return '待办';
    default: return String(event?.role ?? '');
  }
}

/** 按整行截断到 `maxChars`；结尾的空行与只剩角色标题的半截事件一并去掉。 */
function truncateLines(text, maxChars) {
  if (text.length <= maxChars) return { text: text.trimEnd(), truncated: false };
  const cut = text.slice(0, maxChars);
  const at = cut.lastIndexOf('\n');
  const lines = (at > 0 ? cut.slice(0, at) : cut).split('\n');
  for (;;) {
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
    // 去掉角色标题后可能又露出一个空行，因此成对地弹到稳定为止
    if (lines.length > 0 && /^\*\*[^*]+\*\*$/.test(lines[lines.length - 1].trim())) {
      lines.pop();
      continue;
    }
    break;
  }
  return { text: lines.join('\n'), truncated: true };
}

/** 动态加载只读对话读取器；任何失败都还原成 `{ ok: false, error }`。 */
async function readReplay(root, task) {
  const moduleFile = path.join(root, 'core', 'conversation.mjs');
  if (!fs.existsSync(moduleFile)) return { ok: false, error: `未找到对话读取器：${moduleFile}` };
  let readConversation;
  try {
    ({ readConversation } = await import(pathToFileURL(moduleFile).href));
  } catch (error) {
    return { ok: false, error: `对话读取器加载失败：${messageOf(error)}` };
  }
  if (typeof readConversation !== 'function') return { ok: false, error: '对话读取器缺少 readConversation 导出' };
  try {
    const result = await readConversation(task, { limit: TRANSCRIPT_TURNS });
    if (!result || result.ok !== true) return { ok: false, error: result?.reason || '无法读取该任务的对话' };
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error: `对话读取失败：${messageOf(error)}` };
  }
}

/**
 * 把一条任务回放成 markdown：标题、单行 meta 引用块、逐事件「角色 + 正文」。
 * 读取失败时返回 `{ ok: false, taskId, error }`，交由路由以 200 吐给页面。
 */
async function transcriptOf(root, task, maxChars) {
  const taskId = taskIdOf(task);
  const replay = await readReplay(root, task);
  if (replay.ok !== true) return { ok: false, taskId, error: replay.error };

  const result = replay.result;
  const agentName = String(task.agentName ?? task.agent ?? result.agent ?? '');
  const title = result.title || task.title || '未命名会话';
  const cwd = result.cwd || task.cwd || task.dir || '';
  const lines = [`# ${title}`, ''];
  const meta = [agentName, timeRange(task), cwd].filter((part) => typeof part === 'string' && part.trim() !== '');
  if (meta.length > 0) lines.push(`> ${meta.join(' · ')}`, '');

  let events = 0;
  for (const event of Array.isArray(result.events) ? result.events : []) {
    const text = typeof event?.text === 'string' ? event.text.trim() : '';
    if (text === '') continue;
    lines.push(`**${roleLabel(event)}**`, '', text, '');
    events += 1;
  }

  const clipped = truncateLines(lines.join('\n'), maxChars);
  return {
    ok: true,
    taskId,
    agentId: String(task.agentId ?? ''),
    agentName,
    sessionId: String(task.sessionId ?? ''),
    title,
    cwd,
    markdown: clipped.text,
    chars: clipped.text.length,
    truncated: clipped.truncated || result.truncated === true,
    events,
  };
}

/* ------------------------------------------------------------ 引用文件与解析规则 */
/* 原始会话文件不总是可读的（DSH 是多帧 zstd、CodeBuddy 是 SQLite、豆包/千问在 IDE 库内），
   所以对话框里引用的不是原始文件，而是这里导出的一份标准化 Markdown。 */
const REFERENCE_DIR = (root) => path.join(DATA_DIR, '引用');
const RULES_DIR = (root) => path.join(root, 'docs', '解析规则');

/** 把任意 id 收敛成安全文件名（保留可读性，去掉路径分隔符与保留字符）。 */
function safeStem(value, fallback) {
  const text = String(value ?? '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '').slice(0, 90);
  return text === '' ? fallback : text;
}

/** 该 Agent 预制的解析规则文件路径；没有就返回 null。 */
function ruleOf(root, agentId) {
  if (typeof agentId !== 'string' || agentId === '') return null;
  const file = path.join(RULES_DIR(root), `${safeStem(agentId, 'agent')}.md`);
  return fs.existsSync(file) ? file : null;
}

/**
 * 导出一份可供模型读取的 Markdown（同一个人在页面上看到的就是它），并返回路径。
 * 重复导出同一条任务会覆盖同一个文件，路径因此稳定。
 */
async function materialize(root, task, maxChars) {
  const transcript = await transcriptOf(root, task, maxChars);
  if (transcript.ok !== true) return { ok: false, taskId: taskIdOf(task), error: transcript.error };
  const dir = REFERENCE_DIR(root);
  await mkdir(dir, { recursive: true });
  const agentId = String(task.agentId ?? '');
  const rule = ruleOf(root, agentId);
  const file = path.join(dir, `${safeStem(taskIdOf(task), 'task')}.md`);
  const head = [
    '<!-- AgentCenter 只读导出：给 DSH 会话引用用；重新导出会覆盖本文件 -->',
    `<!-- taskId: ${taskIdOf(task)} · agent: ${agentId} · session: ${String(task.sessionId ?? '')} -->`,
    '',
    rule === null ? '' : `> 这些文件的解析规则见：${rule}`,
    '',
  ].join('\n');
  const text = `${head}${transcript.markdown}`;
  await writeFile(file, text, 'utf8');
  return {
    ok: true,
    taskId: taskIdOf(task),
    agentId,
    agentName: String(task.agentName ?? task.agent ?? ''),
    title: String(task.title ?? ''),
    cwd: String(task.cwd ?? task.dir ?? ''),
    path: file,
    rulePath: rule,
    chars: text.length,
    truncated: transcript.truncated === true,
  };
}

/** `docs/解析规则/` 下预制的规则文件清单（按文件名 = agentId）。 */
function listRules(root) {
  const dir = RULES_DIR(root);
  const items = [];
  try {
    for (const name of fs.readdirSync(dir)) {
      const lower = name.toLowerCase();
      if (!lower.endsWith('.md') || lower === 'readme.md') continue;
      const file = path.join(dir, name);
      let bytes = 0;
      try {
        bytes = fs.statSync(file).size;
      } catch {
        /* 忽略读不到的条目 */
      }
      items.push({ agentId: name.slice(0, -3), path: file, bytes });
    }
  } catch {
    /* 目录不存在就是没有规则 */
  }
  items.sort((left, right) => (left.agentId < right.agentId ? -1 : left.agentId > right.agentId ? 1 : 0));
  return { dir, items };
}

/* ------------------------------------------------------------ AI 日报 */
/* 模型来自 DSH 自己的 llm 服务：插件只「选一个模型」，沿用 DSH 里已配置的 provider 与 key，
   不额外保存任何密钥。 */
const DEFAULT_REPORT_FORMAT = `# {date} 工作日报

## 今日概览
- 任务与状态：完成 … 个、进行中 … 个、中断 … 个、等待确认 … 个
- 活跃时长与产出：…
- 涉及项目：…

## 按项目总结
### <项目名>
- 做了什么：…
- 关键产出：…
- 遗留 / 风险：…

## 中断与待确认
- …

## 明日可继续
- …

> 写作要求：只使用下方数据里出现的事实；某项没有数据就写「无」，不要编造项目名、文件名或数字；总长 400–800 字。`;

/** 可选的模型清单：DSH 已注册的 provider × 它给出的模型。 */
async function listModelOptions(ctx) {
  const llm = ctx.get('llm');
  if (llm === undefined || typeof llm.listProviders !== 'function') {
    return { ok: false, items: [], error: 'DSH 的 llm 服务不可用' };
  }
  const items = [];
  let providers = [];
  try {
    providers = llm.listProviders() || [];
  } catch (error) {
    return { ok: false, items: [], error: `读取 provider 失败：${messageOf(error)}` };
  }
  for (const provider of providers) {
    try {
      const models = await llm.listModels(provider.id);
      for (const model of models || []) {
        items.push({
          key: `${provider.id}/${model.id}`,
          provider: provider.id,
          providerName: String(provider.name ?? provider.id),
          model: String(model.id),
          name: String(model.name ?? model.id),
        });
      }
    } catch {
      /* 某个 provider 列不出模型就跳过，不影响其它 */
    }
  }
  return { ok: true, items };
}

/** 当天数据的紧凑摘要：优先用已落盘的确定性日报，没有再按任务列表拼。 */
async function buildDigest(root, date) {
  const file = path.join(DATA_DIR, '日报', `${date}.md`);
  if (fs.existsSync(file)) {
    try {
      return await readFile(file, 'utf8');
    } catch {
      /* 读不动就退回任务列表 */
    }
  }
  const tasks = (await readTasks(root, 'summary.json')).filter(
    (task) => String(task.startedAt ?? '').slice(0, 10) === date,
  );
  if (tasks.length === 0) return `（${date} 没有扫描到任何任务）`;
  const lines = tasks.map((task) => {
    const bits = [
      `[${String(task.agentName ?? task.agent ?? '')}] ${String(task.title ?? '').replace(/\s+/g, ' ').slice(0, 120)}`,
      `状态 ${String(task.status ?? '')}`,
      `活跃 ${Math.round(Number(task.activeMinutes) || 0)} 分钟`,
      `消息 ${Number(task.messages) || 0}`,
    ];
    if (task.dir) bits.push(`目录 ${String(task.dir)}`);
    return `- ${bits.join(' · ')}`;
  });
  const byProject = new Map();
  for (const task of tasks) {
    const key = String(task.project ?? '') || String(task.dir ?? '') || '（未记录项目）';
    byProject.set(key, (byProject.get(key) || 0) + 1);
  }
  const projects = [...byProject.entries()].map(([name, count]) => `- ${name}：${count} 个任务`).join('\n');
  return `日期：${date}，共 ${tasks.length} 个任务\n\n涉及项目：\n${projects}\n\n任务明细：\n${lines.join('\n')}`;
}

/** 把 AI 总结写进 `data/日报/<date>.md` 的「日报总结（AI）」章节；下方确定性日报原样保留。 */
async function saveReport(root, date, markdown, model) {
  const dir = path.join(DATA_DIR, '日报');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${date}.md`);
  const report = await import(pathToFileURL(path.join(root, 'core', 'report.mjs')).href);
  if (typeof report.composeReport !== 'function' || typeof report.splitReport !== 'function') {
    throw new Error('core/report.mjs 缺少 splitReport / composeReport（旧版内核？）');
  }

  let existing = '';
  try {
    existing = await readFile(file, 'utf8');
  } catch {
    /* 当天还没有日报 */
  }
  const previous = report.splitReport(existing);
  // 下方永远是「确定性」的那段：优先沿用文件里已有的，没有就用当前索引现算一份
  let deterministic = previous.deterministic;
  if (deterministic.trim() === '') {
    try {
      const summary = JSON.parse(await readFile(path.join(DATA_DIR, 'summary.json'), 'utf8'));
      deterministic = report.renderReport(summary, date);
    } catch {
      deterministic = `（${date} 没有可用的确定性日报）`;
    }
  }

  const time = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const text = report.composeReport(markdown, deterministic, { model, time });
  await writeFile(`${file}.tmp`, text, 'utf8');
  await rename(`${file}.tmp`, file);
  return {
    ok: true,
    date,
    path: file,
    bytes: Buffer.byteLength(text, 'utf8'),
    model: model || '',
    replacedAi: previous.ai !== null,
  };
}

/** 调一次模型，按配置的格式生成当天日报。 */
async function aiReport(ctx, root, config, date) {
  const key = String(config.reportModel ?? '').trim();
  const cut = key.indexOf('/');
  // 先报「没选模型」这种用户能自己修的错，再看服务是否可用
  if (cut <= 0 || cut === key.length - 1) {
    throw new Error('还没选择日报模型：到 设置 → AgentCenter → 日报模型 里选一个');
  }
  const llm = ctx.get('llm');
  if (llm === undefined || typeof llm.stream !== 'function') throw new Error('DSH 的 llm 服务不可用');
  const provider = key.slice(0, cut);
  const model = key.slice(cut + 1);
  const format = String(config.reportFormat ?? '').trim() === '' ? DEFAULT_REPORT_FORMAT : String(config.reportFormat);
  const digest = await buildDigest(root, date);
  const system = '你是 AgentCenter 的工作日报助手：只输出 Markdown 日报正文，不输出解释、前言或代码围栏。';
  const user = [
    format.replace(/\{date\}/g, date),
    '',
    '----',
    `以下是 ${date} 的真实数据（本机只读扫描结果）。请严格按上面的结构生成当日日报：`,
    '',
    digest,
  ].join('\n');

  let text = '';
  let finish = null;
  for await (const chunk of llm.stream({
    provider,
    model,
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
    maxTokens: 2400,
    temperature: 0.3,
  })) {
    if (chunk.type === 'text-delta') text += chunk.text;
    else if (chunk.type === 'finish') finish = chunk.reason;
  }
  if (finish !== null && finish.kind === 'error') {
    throw new Error(`模型调用失败：${finish.failure?.message ?? '未知原因'}`);
  }
  const markdown = text
    .trim()
    .replace(/^```(?:markdown|md)?\n([\s\S]*?)```\s*$/i, '$1')
    .trim();
  if (markdown === '') throw new Error('模型没有返回内容');
  return { ok: true, date, markdown, chars: markdown.length, model: key };
}

/* ------------------------------------------------------------ 扫描（进程内） */
/* 插件第一次激活时扫一轮，之后由页面的「立即扫描」或 CLI 触发。 */
let initialScan = null;
let scanRunning = null;

async function scanOnce(root) {
  const module = await import(pathToFileURL(path.join(root, 'core', 'scan.mjs')).href);
  if (typeof module.scan !== 'function') throw new Error(`${root}\\core\\scan.mjs 没有导出 scan()`);
  const summary = await module.scan({ dataDir: DATA_DIR });
  const at = summary?.generatedAt ?? summary?.data?.generatedAt ?? new Date().toISOString();
  return { at, summary };
}

/** 同一进程只跑一次，避免每次插件重载都重扫。 */
function ensureInitialScan(ctx, root) {
  if (initialScan !== null) return initialScan;
  initialScan = scanOnce(root)
    .then((result) => {
      ctx.logger?.info?.(`agentcenter: 首次扫描完成 ${result.at}`);
      return result;
    })
    .catch((error) => {
      ctx.logger?.warn?.(`agentcenter: 首次扫描失败 ${messageOf(error)}`);
      return null;
    });
  return initialScan;
}

/** 本地日期键（YYYY-MM-DD），供每日 / 每周去重。 */
function dayKeyOf(ms) {
  const date = new Date(ms);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * 进程内调度：按 `data/config.json` 的 scan 规则（间隔 / 每日 / 每周）定时扫描。
 *
 * DSH 里没有独立守护进程，而页面上的调度设置写的就是这份 config，
 * 所以由插件自己在 Host 进程里每分钟检查一次是否到点——改规则不用重启，下一分钟就生效。
 * 到点后跑一轮增量扫描；勾了自动日报（或到每日定点）时顺手重写当天日报。
 */
async function startScheduler(ctx, root) {
  const scheduler = await import(pathToFileURL(path.join(root, 'core', 'scheduler.mjs')).href);
  const scanner = await import(pathToFileURL(path.join(root, 'core', 'scan.mjs')).href);
  const reporter = await import(pathToFileURL(path.join(root, 'core', 'report.mjs')).href);
  if (typeof scheduler.dueNow !== 'function' || typeof scanner.scan !== 'function') {
    throw new Error('core/scheduler.mjs 或 core/scan.mjs 缺少必要的导出');
  }
  // 首扫（激活时那一次）算作间隔起点，避免刚启动又立刻扫一轮
  const state = { lastIntervalAt: Date.now(), lastDailyKey: '', lastWeeklyKey: '', running: false };

  const tick = async () => {
    if (state.running) return;
    let cfg = {};
    try {
      cfg = scanner.readConfig(DATA_DIR);
    } catch {
      return;
    }
    const now = Date.now();
    const due = scheduler.dueNow(state, cfg, now);
    if (!due.interval && !due.daily && !due.weekly) return;
    state.running = true;
    try {
      const result = await scanner.scan({ dataDir: DATA_DIR });
      if (due.interval) state.lastIntervalAt = now;
      if (due.daily) state.lastDailyKey = dayKeyOf(now);
      if (due.weekly) state.lastWeeklyKey = dayKeyOf(now);
      const scanCfg = (cfg && cfg.scan) || {};
      // 只有「显式开启自动日报」或「到每日定点」才写日报：
      // 早先用 `!== false` 会让缺省值也成立，于是每轮间隔扫描都重写当天日报（把 AI 段冲掉）。
      if (due.report || scanCfg.reportAuto === true) {
        try {
          reporter.writeReport(result, DATA_DIR, todayOf());
        } catch (error) {
          ctx.logger?.warn?.(`agentcenter: 定时日报生成失败 ${messageOf(error)}`);
        }
      }
      const kinds = [due.interval ? '间隔' : '', due.daily ? '每日' : '', due.weekly ? '每周' : ''].filter(Boolean).join('/');
      ctx.logger?.info?.(`agentcenter: 定时扫描完成（${kinds}）`);
    } catch (error) {
      ctx.logger?.warn?.(`agentcenter: 定时扫描失败 ${messageOf(error)}`);
    } finally {
      state.running = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, scheduler.TICK_MS || 60_000);
  if (typeof timer.unref === 'function') timer.unref();
  return {
    stop() {
      clearInterval(timer);
    },
  };
}

/** 手动触发一轮扫描；同时只允许一轮。 */
function requestScan(root) {
  if (scanRunning !== null) return scanRunning;
  scanRunning = scanOnce(root).finally(() => {
    scanRunning = null;
  });
  return scanRunning;
}

/* ------------------------------------------------------------ links.json */

/** 读 `<root>/data/links.json`；缺失/坏掉都当空表，永远返回可用的 `{ version, tasks }`。 */
async function readLinks(root) {
  try {
    const parsed = JSON.parse(await readFile(path.join(DATA_DIR, 'links.json'), 'utf8'));
    const tasks = parsed !== null && typeof parsed === 'object' && parsed.tasks !== null && typeof parsed.tasks === 'object' && !Array.isArray(parsed.tasks) ? parsed.tasks : {};
    return { version: 1, tasks };
  } catch {
    return { version: 1, tasks: {} };
  }
}

/** 原子写 `data/links.json`：先写 `.tmp` 再 rename，目录不在就建。 */
async function writeLinks(root, links) {
  const file = path.join(DATA_DIR, 'links.json');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, `${JSON.stringify(links, null, 2)}\n`, 'utf8');
  await rename(`${file}.tmp`, file);
}

/** Raw row config as the settings page edits it (absent fields stay absent, so defaults never get pinned). */
function rawConfig(config) {
  const raw = {};
  if (typeof config?.root === 'string' && config.root.trim() !== '') raw.root = config.root;
  if (Number.isInteger(Number(config?.port)) && Number(config?.port) > 0) raw.port = Number(config.port);
  raw.showInMore = config?.showInMore !== false;
  raw.showInComposer = config?.showInComposer !== false;
  raw.reportModel = typeof config?.reportModel === 'string' ? config.reportModel : '';
  raw.reportFormat = typeof config?.reportFormat === 'string' ? config.reportFormat : '';
  raw.dataDir = typeof config?.dataDir === 'string' ? config.dataDir : '';
  return raw;
}

/** Validate one settings patch; returns the normalized patch or a message. */
function normalizePatch(input) {
  const patch = {};
  for (const key of ['root', 'port', 'showInMore', 'showInComposer', 'reportModel', 'reportFormat', 'dataDir']) {
    if (!Object.hasOwn(input, key)) continue;
    const value = input[key];
    if (key === 'showInMore' || key === 'showInComposer') {
      if (typeof value !== 'boolean') return { error: `${key} 必须是布尔值` };
      patch[key] = value;
      continue;
    }
    if (key === 'port') {
      const port = Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: '端口必须是 1–65535 的整数' };
      patch.port = port;
      continue;
    }
    if (typeof value !== 'string') return { error: `${key} 必须是字符串` };
    // reportFormat 允许空串（= 用默认模板）；root 同理（= 自动查找）
    patch[key] = key === 'reportFormat' ? value : value.trim();
  }
  if (Object.keys(patch).length === 0) return { error: '没有可保存的字段' };
  return { patch };
}

/** The Loader entry this plugin row lives on: the fiber's own entry, else the profile row by package name. */
function entryOf(ctx) {
  const direct = ctx.fiber?.entry;
  if (direct !== undefined) return direct;
  try {
    const rows = ctx.get('configEditor')?.entries?.();
    if (Array.isArray(rows)) return rows.find((row) => row.name === 'dsh-agentcenter' || row.name === 'agentcenter');
  } catch {
    /* 没有 entries() 的 profile 就走不可保存分支 */
  }
  return undefined;
}

/**
 * @param ctx - Host context.
 * @param config - Bundle row config (`root`, `port`, `showInMore`, `showInComposer`);
 *   every one of them is also editable from Settings → AgentCenter, which writes
 *   the profile's config layer through `ctx.configEditor`.
 */
export function apply(ctx, config = {}) {
  const root = resolveRoot(config);
  DATA_DIR = resolveDataDir(config);
  const port = resolvePort(config);
  // 只有显式 false 才把「更多」里的这一行藏起来；缺省/其它值一律显示。
  const showInMore = config?.showInMore !== false;
  // 同理：只有显式 false 才关掉输入区的「引用历史会话」按钮。
  const showInComposer = config?.showInComposer !== false;
  ctx.logger?.info?.(`agentcenter: app=${root} data=${DATA_DIR} port=${port}`);

  // 服务是在本进程里托管的，没有独立后台进程：
  // - DSH 退出：进程结束，监听随 socket 一起释放；
  // - 插件被停用/卸载：这里显式关掉，避免留下一个还在占端口、又没有路由可用的监听。
  ctx.effect(
    () => () => {
      const app = service.app;
      if (app !== null) {
        service.app = null;
        void app.close().catch(() => {});
        return;
      }
      // 端口上可能还留着上一实例（插件重载前）的监听：同一进程就顺手收掉，
      // 不让停用后的插件在 7788 上留一个没有路由可用的服务。
      const leftover = findLocalServer(port);
      if (leftover !== null) {
        try {
          leftover.close();
        } catch {
          /* 已经不在监听 */
        }
      }
    },
    'agentcenter: close the hosted service on dispose',
  );

  // 插件在这一进程里第一次激活就扫一轮（后台跑，不挡激活），
  // 页面因此一打开就有最新索引与「上次扫描」时间。
  // 激活顺序：迁移数据目录 → 首扫一次 → 启动按配置的定时器（间隔 / 每日 / 每周）
  ctx.effect(() => {
    let stopped = false;
    let handle = null;
    void (async () => {
      await ensureDataDir(root);
      await ensureInitialScan(ctx, root);
      if (stopped) return;
      try {
        handle = await startScheduler(ctx, root);
        ctx.logger?.info?.('agentcenter: 调度已启动（按 data/config.json 的 scan 规则）');
      } catch (error) {
        ctx.logger?.warn?.(`agentcenter: 调度启动失败 ${messageOf(error)}`);
      }
    })();
    return () => {
      stopped = true;
      if (handle !== null) handle.stop();
    };
  }, 'agentcenter: scheduler');

  ctx.inject(['connection'], (scope) => {
    scope.effect(() => {
      const disposers = [
        scope.connection.fetch.register({
          path: `${ROUTE}/status`,
          methods: ['GET'],
          requestBody: 'buffered',
          fetch: async () => json(await describe(root, port)),
        }),
        scope.connection.fetch.register({
          path: `${ROUTE}/start`,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: async (request) => {
            const options = await body(request);
            try {
              await start(root, port);
              return json(await describe(root, port));
            } catch (error) {
              const status = await describe(root, port);
              return json({ ...status, ok: false, error: error instanceof Error ? error.message : String(error) });
            }
          },
        }),
        scope.connection.fetch.register({
          path: `${ROUTE}/stop`,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: async () => {
            try {
              await stop(port);
              return json(await describe(root, port));
            } catch (error) {
              const status = await describe(root, port);
              return json({ ...status, ok: false, error: error instanceof Error ? error.message : String(error) });
            }
          },
        }),
        scope.connection.fetch.register({
          path: `${ROUTE}/config`,
          methods: ['GET'],
          requestBody: 'buffered',
          fetch: async () => {
            const savable = typeof ctx.get('configEditor')?.edit === 'function' && entryOf(ctx) !== undefined;
            try {
              // showInMore / showInComposer 决定两个入口是否存在，页面在挂载时读它；
              // `config` 是设置页要编辑的原始行配置（缺省字段不补默认值，避免把默认值写进配置层）。
              return json({ ...(await describe(root, port)), showInMore, showInComposer, config: rawConfig(config), savable });
            } catch (error) {
              return json({ ok: false, showInMore, showInComposer, config: rawConfig(config), savable, error: messageOf(error) });
            }
          },
        }),
        scope.connection.fetch.register({
          path: `${ROUTE}/settings`,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: async (request) => {
            const input = await body(request);
            const normalized = normalizePatch(input);
            if (normalized.error !== undefined) return json({ ok: false, error: normalized.error }, 400);
            const editor = ctx.get('configEditor');
            const entry = entryOf(ctx);
            if (editor === undefined || typeof editor.edit !== 'function' || entry === undefined) {
              return json({ ok: false, error: '当前 profile 不支持保存插件配置（缺少 configEditor 或入口）' }, 500);
            }
            const patch = normalized.patch;
            // 合并进这一行的原始配置：只动传入的字段，其余保持原样；
            // 空 root 表示「自动查找」，写成空串而不是删掉，语义更明确。
            let edit;
            try {
              edit = editor.edit(entry, (current) => ({ ...current, ...patch }));
            } catch (error) {
              return json({ ok: false, error: `保存失败：${messageOf(error)}` }, 500);
            }
            // 普通字段的写入会重启本插件：响应先回，写入等一拍，避免连接被回收后响应丢失。
            const confirmed = await Promise.race([
              edit.then(() => true, (error) => {
                ctx.logger?.warn?.(`agentcenter: settings write failed: ${messageOf(error)}`);
                return false;
              }),
              sleep(1200).then(() => false),
            ]);
            return json({ ok: true, confirmed, patch, config: rawConfig({ ...config, ...patch }) });
          },
        }),
        scope.connection.fetch.register({
          path: `${ROUTE}/sessions`,
          methods: ['GET'],
          requestBody: 'buffered',
          fetch: async (request) => {
            try {
              // running 说的是「服务侧有没有数据可列」：索引在就为真，与 /status 的探活分开。
              const summaryFile = path.join(DATA_DIR, 'summary.json');
              if (!fs.existsSync(summaryFile)) return json({ ok: true, running: false, total: 0, items: [] });

              const limit = intParam(param(request, 'limit'), SESSION_LIMIT, SESSION_MAX_LIMIT);
              const needle = param(request, 'q').trim().toLowerCase();
              const onlyAgent = param(request, 'agent').trim();
              const tasks = (await readTasks(root, 'summary.json')).filter((task) => task !== null && typeof task === 'object');
              // 各 Agent 的条数：选择面板用它做筛选（不受当前 limit 影响）。
              const counts = new Map();
              for (const task of tasks) {
                const id = String(task.agentId ?? '');
                const row = counts.get(id);
                if (row === undefined) counts.set(id, { id, name: String(task.agentName ?? task.agent ?? id), count: 1 });
                else row.count += 1;
              }
              const agents = [...counts.values()].sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));

              const pool = onlyAgent === '' ? tasks : tasks.filter((task) => String(task.agentId ?? '') === onlyAgent);
              let picked = pool;
              if (needle !== '') {
                // 有关键词时按相关度：标题命中在前，其余字段（项目/目录/Agent 名）在后。
                const scored = [];
                for (const task of pool) {
                  const fields = [task.title, task.project, task.dir, task.agent, task.agentName]
                    .filter((value) => typeof value === 'string')
                    .map((value) => value.toLowerCase());
                  const titleHit = typeof task.title === 'string' && task.title.toLowerCase().includes(needle);
                  const anyHit = fields.some((value) => value.includes(needle));
                  if (anyHit) scored.push({ task, score: titleHit ? 1 : 0 });
                }
                scored.sort((left, right) => right.score - left.score || millisOf(right.task.startedAt) - millisOf(left.task.startedAt));
                picked = scored.map((row) => row.task);
              } else {
                // 默认按开始时间倒序：所有 Agent 混排，最近做过的排在前面。
                // （早先「DSH 在前」会把 60 条名额全给 DSH 会话，别的 Agent 根本翻不到。）
                picked = [...pool].sort((left, right) => millisOf(right.startedAt) - millisOf(left.startedAt));
              }

              return json({ ok: true, running: true, total: picked.length, agents, items: picked.slice(0, limit).map(sessionItem) });
            } catch (error) {
              return json({ ok: false, running: false, total: 0, items: [], error: messageOf(error) });
            }
          },
        }),
        scope.connection.fetch.register({
          path: `${ROUTE}/transcript`,
          methods: ['GET'],
          requestBody: 'buffered',
          fetch: async (request) => {
            try {
              const taskId = param(request, 'taskId').trim();
              if (taskId === '') return json({ ok: false, taskId, error: '缺少 taskId' });
              const maxChars = intParam(param(request, 'maxChars'), TRANSCRIPT_CHARS, TRANSCRIPT_MAX_CHARS);
              const task = await taskRecord(root, taskId);
              if (task === null) return json({ ok: false, taskId, error: '在 data/index.json 与 data/summary.json 中都没有找到该任务' });
              return json(await transcriptOf(root, task, maxChars));
            } catch (error) {
              return json({ ok: false, error: messageOf(error) });
            }
          },
        }),
        scope.connection.fetch.register({
          path: `${ROUTE}/continue`,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: async (request) => {
            try {
              const options = await body(request);
              const taskId = typeof options.taskId === 'string' ? options.taskId.trim() : '';
              if (taskId === '') return json({ ok: false, taskId, error: '缺少 taskId' });
              const task = await taskRecord(root, taskId);
              if (task === null) return json({ ok: false, taskId, error: '在 data/index.json 与 data/summary.json 中都没有找到该任务' });

              const agentId = String(task.agentId ?? '');
              const sessionId = typeof task.sessionId === 'string' ? task.sessionId : '';
              const detail = {
                taskId: taskIdOf(task),
                sessionId,
                title: String(task.title ?? ''),
                cwd: String(task.cwd ?? task.dir ?? ''),
                agentId,
                agentName: String(task.agentName ?? task.agent ?? ''),
              };
              // DSH 的会话 id 就是宿主的会话 id，直接打开比导入更忠实。
              if (agentId === 'deepseek' && sessionId !== '') return json({ ok: true, kind: 'dsh-session', ...detail });

              const transcript = await transcriptOf(root, task, TRANSCRIPT_CHARS);
              if (transcript.ok !== true) return json({ ok: false, taskId, error: transcript.error });
              // 交给对话框的是导出文件的路径，不是整段正文。
              const reference = await materialize(root, task, TRANSCRIPT_MAX_CHARS);
              if (reference.ok !== true) return json({ ok: false, taskId, error: reference.error });
              return json({
                ok: true,
                kind: 'import',
                ...detail,
                filePath: reference.path,
                rulePath: reference.rulePath,
                chars: reference.chars,
                truncated: reference.truncated,
              });
            } catch (error) {
              return json({ ok: false, error: messageOf(error) });
            }
          },
        }),
        scope.connection.fetch.register({
          path: `${ROUTE}/materialize`,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: async (request) => {
            const options = await body(request);
            const taskId = typeof options.taskId === 'string' ? options.taskId.trim() : '';
            if (taskId === '') return json({ ok: false, error: '缺少 taskId' }, 400);
            try {
              const task = await taskRecord(root, taskId);
              if (task === null) return json({ ok: false, taskId, error: '在索引里找不到该任务' });
              const maxChars = intParam(options.maxChars, TRANSCRIPT_CHARS, TRANSCRIPT_MAX_CHARS);
              return json(await materialize(root, task, maxChars));
            } catch (error) {
              return json({ ok: false, taskId, error: messageOf(error) });
            }
          },
        }),
        scope.connection.fetch.register({
          path: `${ROUTE}/rules`,
          methods: ['GET'],
          requestBody: 'buffered',
          fetch: async () => {
            const { dir, items } = listRules(root);
            return json({ ok: true, dir, items, total: items.length });
          },
        }),
        scope.connection.fetch.register({
          path: `${ROUTE}/models`,
          methods: ['GET'],
          requestBody: 'buffered',
          fetch: async () => {
            const options = await listModelOptions(ctx);
            return json({ ...options, current: rawConfig(config).reportModel, defaultFormat: DEFAULT_REPORT_FORMAT });
          },
        }),
        scope.connection.fetch.register({
          path: `${ROUTE}/report/ai`,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: async (request) => {
            const options = await body(request);
            const date = typeof options.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(options.date.trim()) ? options.date.trim() : todayOf();
            try {
              return json(await aiReport(ctx, root, config, date));
            } catch (error) {
              return json({ ok: false, date, error: messageOf(error) });
            }
          },
        }),
        scope.connection.fetch.register({
          path: `${ROUTE}/report/save`,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: async (request) => {
            const options = await body(request);
            const date = typeof options.date === 'string' ? options.date.trim() : '';
            const markdown = typeof options.markdown === 'string' ? options.markdown : '';
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ ok: false, error: 'date 必须是 YYYY-MM-DD' }, 400);
            if (markdown.trim() === '') return json({ ok: false, error: '没有可保存的内容' }, 400);
            if (markdown.length > 400_000) return json({ ok: false, error: '内容过大（超过 400KB）' }, 400);
            try {
              return json(await saveReport(root, date, markdown, typeof options.model === 'string' ? options.model : ''));
            } catch (error) {
              return json({ ok: false, date, error: `写入失败：${messageOf(error)}` });
            }
          },
        }),
        scope.connection.fetch.register({
          path: `${ROUTE}/scan`,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: async () => {
            try {
              const result = await requestScan(root);
              return json({ ok: true, at: result.at, scannedAt: hhmmOf(result.at), health: await probe(port) });
            } catch (error) {
              return json({ ok: false, error: `扫描失败：${messageOf(error)}` });
            }
          },
        }),
        scope.connection.fetch.register({
          path: `${ROUTE}/links`,
          methods: ['GET'],
          requestBody: 'buffered',
          fetch: async () => {
            try {
              return json({ ok: true, links: await readLinks(root) });
            } catch (error) {
              return json({ ok: false, links: { version: 1, tasks: {} }, error: messageOf(error) });
            }
          },
        }),
        scope.connection.fetch.register({
          path: `${ROUTE}/link`,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: async (request) => {
            try {
              const options = await body(request);
              const taskId = typeof options.taskId === 'string' ? options.taskId.trim() : '';
              const sessionId = typeof options.sessionId === 'string' ? options.sessionId.trim() : '';
              if (taskId === '' || sessionId === '') return json({ ok: false, error: '缺少 taskId / sessionId' }, 400);

              const links = await readLinks(root);
              const previous = links.tasks[taskId] !== null && typeof links.tasks[taskId] === 'object' ? links.tasks[taskId] : {};
              // 合并，不覆盖别的条目：旧记录的字段先铺底，本次请求的字段在上。
              links.tasks = {
                ...links.tasks,
                [taskId]: {
                  sessionId,
                  at: new Date().toISOString(),
                  action: typeof options.action === 'string' && options.action.trim() !== '' ? options.action.trim() : 'continue',
                  title: typeof options.title === 'string' && options.title !== '' ? options.title : String(previous.title ?? ''),
                  agentId: typeof options.agentId === 'string' && options.agentId !== '' ? options.agentId : String(previous.agentId ?? ''),
                },
              };
              await writeLinks(root, links);
              return json({ ok: true, links });
            } catch (error) {
              // 写不进去（目录只读、磁盘满）也是一种要说清的结果。
              return json({ ok: false, error: `写入 data/links.json 失败：${messageOf(error)}` });
            }
          },
        }),
      ];
      return async () => {
        for (const dispose of disposers) {
          try {
            await dispose();
          } catch {
            /* route already gone */
          }
        }
      };
    }, 'agentcenter: routes');
  });
}