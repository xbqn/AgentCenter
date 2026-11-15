// AgentCenter DSH plugin — Host-half check (no Harness required).
//
// Applies plugin/index.js with a fake connection route registry, then drives every
// route the page and the composer control use:
//   node tools\plugin-check.mjs [port]
//
// Covers: route contract, service probe/start/stop lifecycle, the served page,
// the row config flags, the session index, the markdown transcript, the
// continue plan (DSH session vs import), and the link table round-trip.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply } from '../plugin/index.js';
import { splitReport, writeReport } from '../core/report.mjs';

const PORT = Number(process.argv[2]) || 7793;
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 插件自带的运行时（npm 包里就是 app/），数据目录单独算
const ROOT = path.join(REPO, 'plugin', 'app');
const DATA_DIR = path.join(REPO, '.scratch', 'plugin-data');
const BASE = 'http://127.0.0.1:' + PORT;
const LINKS_FILE = path.join(DATA_DIR, 'links.json');
fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
// 索引/日报都从仓库的 data/ 拷一份进来，检查用真实数据但不动用户目录
for (const name of ['summary.json', 'index.json', 'scans.json', 'overrides.json']) {
  const from = path.join(REPO, 'data', name);
  if (fs.existsSync(from)) fs.copyFileSync(from, path.join(DATA_DIR, name));
}
const reportsFrom = path.join(REPO, 'data', '日报');
if (fs.existsSync(reportsFrom)) {
  fs.mkdirSync(path.join(DATA_DIR, '日报'), { recursive: true });
  for (const name of fs.readdirSync(reportsFrom)) {
    if (name.endsWith('.md')) fs.copyFileSync(path.join(reportsFrom, name), path.join(DATA_DIR, '日报', name));
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** 端口上还有没有 AgentCenter 在应答。 */
const alive = async (port) => {
  try {
    const response = await fetch('http://127.0.0.1:' + port + '/api/health', { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
};

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail: detail ?? '' });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail === undefined || detail === '' ? '' : '  — ' + detail}`);
};

function harness(config, options = {}) {
  const routes = new Map();
  const written = [];
  const entry = { id: 'agentcenter', config: { ...config } };
  const editor = {
    async edit(target, change) {
      const next = change(target.config ?? {});
      written.push({ id: target.id, config: next });
      target.config = next;
      return undefined;
    },
  };
  const disposers = [];
  const scope = {
    connection: {
      fetch: {
        register(route) {
          routes.set(route.path, route);
          return async () => routes.delete(route.path);
        },
      },
    },
    effect(run) {
      const cleanup = run();
      if (typeof cleanup === 'function') disposers.push(cleanup);
      return cleanup;
    },
  };
  apply(
    {
      logger: { info: (message) => console.log('  [host]', message) },
      fiber: options.noEntry ? undefined : { entry },
      get: (key) => {
        if (key === 'llm') return options.llm;
        if (key === 'configEditor' && options.noEditor !== true) return editor;
        return undefined;
      },
      effect(run) {
        const cleanup = run();
        if (typeof cleanup === 'function') disposers.push(cleanup);
        return cleanup;
      },
      inject: (_deps, callback) => callback(scope),
    },
    config,
  );
  const callRoute = async (path, method, payload) => {
    const route = routes.get(path.split('?')[0]);
    if (route === undefined) throw new Error('route not registered: ' + path);
    const init = { method };
    if (payload !== undefined) {
      init.body = JSON.stringify(payload);
      init.headers = { 'content-type': 'application/json' };
    }
    const response = await route.fetch(new Request('http://127.0.0.1' + path, init));
    return { status: response.status, body: await response.json() };
  };
  return {
    routes,
    call: callRoute,
    written,
    entry,
    /** 模拟插件停用/卸载：跑一遍所有 effect 的清理函数。 */
    async dispose() {
      for (const cleanup of disposers) {
        try {
          await cleanup();
        } catch {
          /* 清理失败不影响后续 */
        }
      }
    },
  };
}

const primary = harness({ root: ROOT, dataDir: DATA_DIR, port: PORT, showInComposer: true });
const routes = primary.routes;
const written = primary.written;

const call = async (path, method, payload) => {
  const route = routes.get(path.split('?')[0]);
  if (route === undefined) throw new Error('route not registered: ' + path);
  const init = { method };
  if (payload !== undefined) {
    init.body = JSON.stringify(payload);
    init.headers = { 'content-type': 'application/json' };
  }
  const response = await route.fetch(new Request('http://127.0.0.1' + path, init));
  return { status: response.status, body: await response.json() };
};

// 1. routes
check(
  'sixteen routes registered',
  routes.size === 16,
  [...routes.keys()].map((key) => key.replace('/api/agentcenter', '')).join(', '),
);
check(
  'route methods are GET reads / POST writes',
  routes.get('/api/agentcenter/status')?.methods.join() === 'GET' &&
    routes.get('/api/agentcenter/start')?.methods.join() === 'POST' &&
    routes.get('/api/agentcenter/stop')?.methods.join() === 'POST' &&
    routes.get('/api/agentcenter/config')?.methods.join() === 'GET' &&
    routes.get('/api/agentcenter/sessions')?.methods.join() === 'GET' &&
    routes.get('/api/agentcenter/transcript')?.methods.join() === 'GET' &&
    routes.get('/api/agentcenter/continue')?.methods.join() === 'POST' &&
    routes.get('/api/agentcenter/links')?.methods.join() === 'GET' &&
    routes.get('/api/agentcenter/link')?.methods.join() === 'POST' &&
    routes.get('/api/agentcenter/settings')?.methods.join() === 'POST' &&
    routes.get('/api/agentcenter/materialize')?.methods.join() === 'POST' &&
    routes.get('/api/agentcenter/scan')?.methods.join() === 'POST' &&
    routes.get('/api/agentcenter/rules')?.methods.join() === 'GET' &&
    routes.get('/api/agentcenter/models')?.methods.join() === 'GET' &&
    routes.get('/api/agentcenter/report/ai')?.methods.join() === 'POST' &&
    routes.get('/api/agentcenter/report/save')?.methods.join() === 'POST',
);

// 2. status shape while stopped
const before = await call('/api/agentcenter/status', 'GET');
check('status is 200 while stopped', before.status === 200);
check('status reports stopped', before.body.running === false && before.body.managed === false);
check(
  'status carries port / url / root',
  before.body.port === PORT && before.body.url === BASE + '/' && before.body.root === ROOT && before.body.dataDir === DATA_DIR,
  JSON.stringify({ port: before.body.port, url: before.body.url }),
);
// 公开仓库的 data/ 里没有真实索引（只有说明文件），所以 hasIndex 随环境变化；
// 这里断言它准确反映了索引是否存在，而不是硬性要求 data/ 里带数据。
check(
  'service script and index are reported',
  before.body.serveExists === true && before.body.hasIndex === fs.existsSync(path.join(REPO, 'data', 'index.json')),
);

// 3. row config reachable to the page
const config = await call('/api/agentcenter/config', 'GET');
check('config is 200', config.status === 200);
check('config exposes the composer entry flag', config.body.showInComposer === true);
check('config no longer exposes a placement flag (DSH owns the More menu)', config.body.showInMore === undefined);
check('config is savable from the settings page', config.body.savable === true);
check('config carries the raw row values', config.body.config?.port === PORT && config.body.config?.root === ROOT);
const hiddenRoutes = harness({ root: ROOT, dataDir: DATA_DIR, port: PORT, showInComposer: false }).routes;
const hidden = await hiddenRoutes.get('/api/agentcenter/config').fetch(new Request('http://127.0.0.1/api/agentcenter/config', { method: 'GET' }));
const hiddenBody = await hidden.json();
check('explicit false hides the composer entry', hiddenBody.showInComposer === false);

// 3b. Settings → AgentCenter writes through the config editor (the profile config layer)
const savedSettings = await call('/api/agentcenter/settings', 'POST', { showInComposer: false });
check('settings writes through the config editor', savedSettings.body.ok === true && written.length === 1, JSON.stringify(written[0] && written[0].config));
check('settings keeps the untouched fields', written[0]?.config?.showInComposer === false && written[0]?.config?.port === PORT);
const restarted = harness(primary.entry.config).routes;
const restartedConfig = await restarted.get('/api/agentcenter/config').fetch(new Request('http://127.0.0.1/api/agentcenter/config', { method: 'GET' }));
const restartedBody = await restartedConfig.json();
check('the saved value is what the restarted plugin reads', restartedBody.config.showInComposer === false && restartedBody.showInComposer === false);
const badPort = await call('/api/agentcenter/settings', 'POST', { port: 70000 });
check('settings rejects an invalid port', badPort.status === 400, badPort.body.error);
const emptyPatch = await call('/api/agentcenter/settings', 'POST', { nope: 1 });
check('settings rejects an empty patch', emptyPatch.status === 400);
const noEditorRoutes = harness({ root: ROOT, dataDir: DATA_DIR, port: PORT }, { noEditor: true }).routes;
const noEditorConfig = await noEditorRoutes.get('/api/agentcenter/config').fetch(new Request('http://127.0.0.1/api/agentcenter/config', { method: 'GET' }));
check('config reports not savable without a config editor', (await noEditorConfig.json()).savable === false);
const noEditorWrite = await noEditorRoutes.get('/api/agentcenter/settings').fetch(new Request('http://127.0.0.1/api/agentcenter/settings', { method: 'POST', body: JSON.stringify({ showInComposer: false }) }));
check('settings refuse to write without a config editor', noEditorWrite.status === 500);

// 4. stop refuses when the service is not ours (or is already down)
const idleStop = await call('/api/agentcenter/stop', 'POST');
check('stop on a stopped service is a no-op', idleStop.body.ok === true && idleStop.body.running === false);

// 5. start spawns the real service
const started = await call('/api/agentcenter/start', 'POST');
check('start is 200', started.status === 200);
check('start reports running + managed', started.body.running === true && started.body.managed === true, 'pid ' + started.body.pid);
check('health mode is live (index present)', started.body.mode === 'live', String(started.body.mode));

// 6. the page the plugin shows is actually served
const page = await fetch(BASE + '/');
const html = await page.text();
check('page answers 200', page.status === 200);
check('page is the AgentCenter H5 shell', html.length > 10000 && html.includes('AgentCenter'), html.length + ' bytes');
check('page sets no X-Frame-Options (embeddable)', page.headers.get('x-frame-options') === null);

// 7. start is idempotent
const again = await call('/api/agentcenter/start', 'POST');
check('start twice keeps one service', again.body.running === true && again.body.managed === true);

// 8. session index read from the scan output (the composer picker source)
const list = await call('/api/agentcenter/sessions?limit=20', 'GET');
check('sessions lists the index', list.body.ok === true && Array.isArray(list.body.items) && list.body.items.length > 0, list.body.items ? list.body.items.length + ' items' : '');
check('sessions mixes agents by recency', new Set(list.body.items.map((row) => row.agentId)).size > 1, [...new Set(list.body.items.map((row) => row.agentId))].join(','));
check('sessions lists every agent as a facet', Array.isArray(list.body.agents) && list.body.agents.length >= 5, list.body.agents ? list.body.agents.length + ' agents' : 'none');
// 顶上那条可能是刚建的、几乎空的会话；回放断言挑一条真有内容的。
let dshTask = list.body.items.find((row) => row.agentId === 'deepseek' && Number(row.messages) >= 20) ?? list.body.items[0];
check('session rows carry what the picker shows', typeof dshTask?.title === 'string' && typeof dshTask?.sessionId === 'string');
const filtered = await call('/api/agentcenter/sessions?agent=qoder&limit=5', 'GET');
check('sessions filters by agent', filtered.body.ok === true && filtered.body.items.length > 0 && filtered.body.items.every((row) => row.agentId === 'qoder'), filtered.body.items[0]?.agentId);
const searched = await call('/api/agentcenter/sessions?q=' + encodeURIComponent('CodeBuddy') + '&limit=3', 'GET');
const otherTask = (searched.body.items || []).find((row) => row.agentId !== 'deepseek');
check('a non-DSH task is found for import', otherTask !== undefined, otherTask ? otherTask.agentId : 'none');

// 9. transcript is markdown（索引里可能混着刚建的空会话，挑第一条读得出角色行的）
let transcript = null;
for (const candidate of list.body.items.filter((row) => row.agentId === 'deepseek').slice(0, 6)) {
  const result = await call('/api/agentcenter/transcript?taskId=' + encodeURIComponent(candidate.id) + '&maxChars=4000', 'GET');
  if (transcript === null) transcript = result;
  const markdown = result.body?.markdown;
  if (result.body.ok === true && typeof markdown === 'string' && markdown.includes('**')) {
    transcript = result;
    dshTask = candidate;
    break;
  }
}
check('transcript is ok', transcript.body.ok === true, transcript.body.error || '');
check(
  'transcript is markdown with role headings',
  typeof transcript.body.markdown === 'string' &&
    transcript.body.markdown.includes('# ') &&
    transcript.body.markdown.includes('**'),
  (transcript.body.markdown || '').length + ' chars',
);

// 10. continue plan
const plan = await call('/api/agentcenter/continue', 'POST', { taskId: dshTask.id });
check('continue on a DSH task opens its session', plan.body.ok === true && plan.body.kind === 'dsh-session', plan.body.kind);
check('continue returns the DSH session id', plan.body.sessionId === dshTask.sessionId, plan.body.sessionId);
if (otherTask) {
  const imported = await call('/api/agentcenter/continue', 'POST', { taskId: otherTask.id });
  check('continue on another agent imports a reference file', imported.body.ok === true && imported.body.kind === 'import' && typeof imported.body.filePath === 'string', imported.body.kind);
  check('the import points at an existing export', typeof imported.body.filePath === 'string' && fs.existsSync(imported.body.filePath), imported.body.filePath);
  check('the import defaults the workspace to the task directory', typeof imported.body.cwd === 'string' && imported.body.cwd !== '', imported.body.cwd);
  check('the import carries the parsing rules file', typeof imported.body.rulePath === 'string' && fs.existsSync(imported.body.rulePath), imported.body.rulePath || 'none');
}

// 11. link table round-trip
const link = await call('/api/agentcenter/link', 'POST', { taskId: 'selftest:link', sessionId: 'self-test-session', action: 'created' });
check('link records an entry', link.body.ok === true && link.body.links.tasks['selftest:link']?.sessionId === 'self-test-session');
const links = await call('/api/agentcenter/links', 'GET');
check('links reads it back', links.body.ok === true && links.body.links.tasks['selftest:link'] !== undefined);
const badLink = await call('/api/agentcenter/link', 'POST', { taskId: '' });
check('link rejects a missing taskId', badLink.status === 400 && badLink.body.ok === false);

// 11b. reference export, rules index, and a scan
const exported = await call('/api/agentcenter/materialize', 'POST', { taskId: dshTask.id });
check('materialize writes a readable export', exported.body.ok === true && typeof exported.body.path === 'string' && fs.existsSync(exported.body.path), exported.body.path || exported.body.error);
check('the export lives under the data dir', typeof exported.body.path === 'string' && exported.body.path.startsWith(path.join(DATA_DIR, '引用')), exported.body.path || '');
check('the export starts with the AgentCenter header', typeof exported.body.path === 'string' && fs.readFileSync(exported.body.path, 'utf8').includes('AgentCenter 只读导出'));
const rules = await call('/api/agentcenter/rules', 'GET');
check('rules lists one file per supported agent', rules.body.ok === true && rules.body.items.length >= 12, rules.body.items.length + ' rules');
check('every adapter has a rules file', ['deepseek', 'claudecode', 'codebuddy', 'workbuddy', 'qwen'].every((id) => (rules.body.items || []).some((row) => row.agentId === id)));
const badExport = await call('/api/agentcenter/materialize', 'POST', {});
check('materialize rejects a missing taskId', badExport.status === 400);

// 11b2. AI 日报：模型清单与「没选模型」的明确报错
const models = await call('/api/agentcenter/models', 'GET');
check('models answers with a list shape', models.status === 200 && Array.isArray(models.body.items), models.body.error || models.body.items.length + ' models');
check('models exposes the default report format', typeof models.body.defaultFormat === 'string' && models.body.defaultFormat.includes('按项目总结'));
const aiNoModel = await call('/api/agentcenter/report/ai', 'POST', { date: '2026-11-06' });
check('AI report without a model explains what to configure', aiNoModel.body.ok === false && String(aiNoModel.body.error).includes('日报模型'), aiNoModel.body.error);
const savedFormat = await call('/api/agentcenter/settings', 'POST', { reportModel: 'demo-provider/demo-model', reportFormat: '# 自定义格式' });
check('settings stores the report model and format', savedFormat.body.ok === true && written.at(-1)?.config?.reportModel === 'demo-provider/demo-model' && written.at(-1)?.config?.reportFormat === '# 自定义格式');

// 11b3. AI 日报端到端（假 llm：验证模型清单、prompt 组装、围栏清洗、错误传播）
const prompts = [];
const fakeLlm = {
  listProviders: () => [{ id: 'demo', name: 'Demo Provider' }],
  listModels: async () => [{ provider: 'demo', id: 'm1', name: 'Demo Model' }],
  async *stream(options) {
    prompts.push(options);
    if (options.model === 'broken') {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: '限额用尽', code: 'quota' } } };
      return;
    }
    yield { type: 'text-delta', index: 0, text: '```markdown\n# 2026-11-06 工作日报\n\n## 按项目总结\n- 完成 3 个任务\n```' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  },
};
const aiHarness = harness(
  { root: ROOT, dataDir: DATA_DIR, port: PORT, reportModel: 'demo/m1', reportFormat: '# {date} 工作日报\n\n## 按项目总结' },
  { llm: fakeLlm },
);
const aiModels = await aiHarness.call('/api/agentcenter/models', 'GET');
check('models lists the DSH provider models', aiModels.body.ok === true && aiModels.body.items.some((row) => row.key === 'demo/m1'), JSON.stringify(aiModels.body.items.map((row) => row.key)));
const ai = await aiHarness.call('/api/agentcenter/report/ai', 'POST', { date: '2026-11-06' });
check('AI report returns markdown without code fences', ai.body.ok === true && String(ai.body.markdown).startsWith('# 2026-11-06 工作日报') && !String(ai.body.markdown).includes('`'), (ai.body.markdown || ai.body.error || '').slice(0, 60));
const sent = prompts.at(-1) || {};
const userText = sent.messages?.[0]?.content?.[0]?.text ?? '';
check('the prompt carries the configured format and the day data', userText.includes('# 2026-11-06 工作日报') && userText.includes('真实数据') && userText.length > 200, userText.length + ' chars');
check('the prompt is sent to the chosen provider and model', sent.provider === 'demo' && sent.model === 'm1');
const broken = harness({ root: ROOT, dataDir: DATA_DIR, port: PORT, reportModel: 'demo/broken' }, { llm: fakeLlm });
const brokenAi = await broken.call('/api/agentcenter/report/ai', 'POST', { date: '2026-11-06' });
check('a model failure surfaces as an error', brokenAi.body.ok === false && String(brokenAi.body.error).includes('限额用尽'), brokenAi.body.error);

// 11b4. 保存 AI 日报到 data/日报/<date>.md（同日覆盖，写前校验）
const SAVE_DATE = '2000-01-01';
const saveFile = path.join(DATA_DIR, '日报', SAVE_DATE + '.md');
const savedReport = await call('/api/agentcenter/report/save', 'POST', { date: SAVE_DATE, markdown: '# 测试日报\n\n- 一行内容', model: 'demo/m1' });
check('save writes the daily report file', savedReport.body.ok === true && fs.existsSync(saveFile), savedReport.body.path || savedReport.body.error);
const savedText = fs.existsSync(saveFile) ? fs.readFileSync(saveFile, 'utf8') : '';
check('the AI summary lands in its own section', savedText.startsWith('## 日报总结（AI）') && savedText.includes('# 测试日报') && savedText.includes('模型 demo/m1'), savedText.split('\n')[0]);
check('the deterministic report stays below the AI section', savedText.includes('## 确定性日报（扫描生成）'), savedText.includes('## 确定性日报（扫描生成）') ? 'section present' : 'missing');
const factsBefore = splitReport(savedText).deterministic;
const savedAgain = await call('/api/agentcenter/report/save', 'POST', { date: SAVE_DATE, markdown: '# 换一版总结', model: 'demo/m2' });
const savedTwice = fs.readFileSync(saveFile, 'utf8');
check('saving again replaces only the AI section', savedTwice.includes('# 换一版总结') && savedTwice.includes('模型 demo/m2') && splitReport(savedTwice).deterministic === factsBefore);
check('re-saving keeps the file structure', savedTwice.startsWith('## 日报总结（AI）') && savedTwice.includes('## 确定性日报（扫描生成）'));
// 「生成今日日报」（确定性重生成）也不能把 AI 段抹掉
const regenerated = writeReport({ data: { tasks: [], todos: [], agents: [] } }, DATA_DIR, SAVE_DATE);
const afterRegen = fs.readFileSync(saveFile, 'utf8');
check(
  'regenerating the deterministic report keeps the AI section',
  afterRegen.startsWith('## 日报总结（AI）') && afterRegen.includes('# 换一版总结') && afterRegen.includes('## 确定性日报（扫描生成）'),
  regenerated.date,
);

const badDate = await call('/api/agentcenter/report/save', 'POST', { date: 'yesterday', markdown: '# x' });
check('save rejects a malformed date', badDate.status === 400);
const emptyReport = await call('/api/agentcenter/report/save', 'POST', { date: SAVE_DATE, markdown: '   ' });
check('save rejects empty content', emptyReport.status === 400);
try { fs.unlinkSync(saveFile); } catch {}

// 11c. an explicit scan refreshes the index
const scanned = await call('/api/agentcenter/scan', 'POST');
check('scan runs and reports a time', scanned.body.ok === true && typeof scanned.body.at === 'string', scanned.body.scannedAt || scanned.body.error);

// 12. stop ends the service it started
const stopped = await call('/api/agentcenter/stop', 'POST');
check('stop reports stopped', stopped.body.ok === true && stopped.body.running === false);
const after = await call('/api/agentcenter/status', 'GET');
check('status confirms the service is gone', after.body.running === false && after.body.managed === false);

// 12b. 端口上留着「重载前的实例」时，stop 能把它收掉（同进程句柄不可达的情况）
const ORPHAN_PORT = await new Promise((resolve) => {
  const probeServer = net.createServer();
  probeServer.listen(0, '127.0.0.1', () => {
    const { port } = probeServer.address();
    probeServer.close(() => resolve(port));
  });
});
const { createAgentCenterServer } = await import('../h5/serve.mjs');
const orphan = createAgentCenterServer({ port: ORPHAN_PORT });
await orphan.listen();
// 换一个只认识端口、没有句柄的实例来停：模拟插件重载后的孤儿监听
const second = harness({ root: ROOT, dataDir: DATA_DIR, port: ORPHAN_PORT });
const stopRoute = second.routes.get('/api/agentcenter/stop');
const stopResponse = await stopRoute.fetch(new Request('http://127.0.0.1/api/agentcenter/stop', { method: 'POST' }));
const orphanStop = { status: stopResponse.status, body: await stopResponse.json() };
check('stop reclaims an in-process leftover listener', orphanStop.body.ok === true && orphanStop.body.running === false, orphanStop.body.error || 'closed');
const orphanGone = await alive(ORPHAN_PORT);
check('the leftover port is actually released', orphanGone === false, 'port ' + ORPHAN_PORT);

// 13. 停用/卸载插件不会留下还在占端口的后台服务（DSH 退出同理：监听随进程释放）
// 本机有些端口被别的工具占着（backupDisk / syncDisk），向系统要一个空闲端口
const DISPOSE_PORT = await new Promise((resolve) => {
  const probeServer = net.createServer();
  probeServer.listen(0, '127.0.0.1', () => {
    const { port } = probeServer.address();
    probeServer.close(() => resolve(port));
  });
});
const disposable = harness({ root: ROOT, dataDir: DATA_DIR, port: DISPOSE_PORT });
await disposable.routes.get('/api/agentcenter/start').fetch(new Request('http://127.0.0.1/api/agentcenter/start', { method: 'POST' }));
const beforeDispose = await alive(DISPOSE_PORT);
await disposable.dispose();
await sleep(250);
check('the hosted service is up before disposing', beforeDispose === true, 'port ' + DISPOSE_PORT);
check('disposing the plugin releases the port', (await alive(DISPOSE_PORT)) === false, 'port ' + DISPOSE_PORT + ' released');

// 13b. 停用时连「上一实例留下的监听」也会收掉（插件重载后的常见残留）
const LEFTOVER_PORT = await new Promise((resolve) => {
  const probeServer = net.createServer();
  probeServer.listen(0, '127.0.0.1', () => {
    const { port } = probeServer.address();
    probeServer.close(() => resolve(port));
  });
});
const leftoverServer = createAgentCenterServer({ port: LEFTOVER_PORT });
await leftoverServer.listen();
const ownerHarness = harness({ root: ROOT, dataDir: DATA_DIR, port: LEFTOVER_PORT });
check('a leftover listener is up before disposing', (await alive(LEFTOVER_PORT)) === true, 'port ' + LEFTOVER_PORT);
await ownerHarness.dispose();
await sleep(250);
check('disposing also closes a leftover on the plugin port', (await alive(LEFTOVER_PORT)) === false, 'port ' + LEFTOVER_PORT);

// leave no self-test entry behind
try {
  const table = JSON.parse(fs.readFileSync(LINKS_FILE, 'utf8'));
  delete table.tasks['selftest:link'];
  fs.writeFileSync(LINKS_FILE, `${JSON.stringify(table, null, 2)}\n`, 'utf8');
} catch {
  /* no link file, nothing to clean */
}

const failed = results.filter((row) => row.pass === false);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);