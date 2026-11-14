// 用 Edge 的 CDP 直接验证 H5 真实渲染（不依赖 playwright）
// 用法：node tools\render-check.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 7794;
const CDP = 9333;
const SHOTS = path.join(REPO, '.scratch', 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHttp(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return await r.json(); } catch {}
    await sleep(250);
  }
  throw new Error('timeout ' + url);
}

const srv = spawn(process.execPath, [path.join(REPO, 'h5', 'serve.mjs'), '--port', String(PORT)], { cwd: REPO, stdio: 'ignore' });
const userDir = path.join(REPO, '.scratch', 'edge-profile-' + Date.now());
const edge = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + CDP, '--user-data-dir=' + userDir, 'about:blank'
], { stdio: 'ignore' });

let ws = null, msgId = 0;
const pending = new Map();
const errors = [];

function connect(url) {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(url);
    ws.onopen = () => resolve();
    ws.onerror = (e) => reject(new Error('ws error'));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        errors.push((d.exception && d.exception.description) || d.text || 'exception');
      }
      if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
        errors.push('log: ' + m.params.entry.text);
      }
    };
  });
}

function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
}

async function evalJs(expr) {
  const r = await rpc('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || ''));
  return r.result.value;
}

async function viewport(w, h) {
  await rpc('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 500 });
}

async function shot(name) {
  const r = await rpc('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(r.data, 'base64'));
}

const results = [];
function rec(name, pass, msg) { results.push({ name, pass, msg }); }

try {
  await waitHttp('http://127.0.0.1:' + CDP + '/json/version');
  const list = await waitHttp('http://127.0.0.1:' + CDP + '/json/list');
  const target = list.find((t) => t.type === 'page');
  connect(target.webSocketDebuggerUrl);
  await new Promise((r) => setTimeout(r, 300));
  await rpc('Page.enable');
  await rpc('Runtime.enable');
  await rpc('Log.enable');

  const base = 'http://127.0.0.1:' + PORT + '/';
  await rpc('Page.navigate', { url: base });
  await sleep(1200);

  // 1. 真实数据是否已加载（不是演示数据）
  const live = await evalJs(`(function(){
    return {
      taskCount: (typeof TASKS !== 'undefined' ? TASKS.length : -1),
      agentCount: (typeof AGENTS !== 'undefined' ? AGENTS.filter(a=>a.inst).length : -1),
      todoCount: (typeof TODOS !== 'undefined' ? TODOS.length : -1),
      fileCount: (typeof FILES !== 'undefined' ? FILES.length : -1),
      live: typeof state !== 'undefined' ? state.live : null,
      online: typeof state !== 'undefined' ? state.online : null,
      firstTask: typeof TASKS !== 'undefined' && TASKS[0] ? TASKS[0].title : null,
      firstDir: typeof TASKS !== 'undefined' && TASKS[0] ? TASKS[0].dir : null
    };
  })()`);
  rec('真实数据已注入（非演示数据）', live.live === true && live.taskCount > 100,
    'TASKS=' + live.taskCount + ' AGENTS=' + live.agentCount + ' TODOS=' + live.todoCount + ' FILES=' + live.fileCount + ' live=' + live.live);
  rec('任务带真实物理路径', !!(live.firstDir && live.firstDir.includes('\\')),
    '首任务目录：' + String(live.firstDir).slice(0, 60));

  // 2. 11 条路由逐个可达 + 标题正确
  const routes = ['home', 'tasks', 'todos', 'space', 'config', 'sched', 'conn', 'arch', 'report', 'me'];
  // 任务 id 必须从任务列表页取：概览页现在只显示「进行中任务」，可能为空且用的是紧凑行 .crow
  await evalJs(`location.hash = '#/tasks'`);
  await sleep(500);
  const taskId = await evalJs(`(function(){
    var a=document.querySelector('#view a.trow');
    if(a) return a.getAttribute('href').replace('#/task/','');
    var t=typeof TASKS!=='undefined' && TASKS.length ? TASKS[0] : null;
    return t ? t.id : '';
  })()`);
  routes.push('task/' + taskId);
  const routeResults = [];
  for (const r of routes) {
    await evalJs(`location.hash = '#/${r}'`);
    await sleep(320);
    const info = await evalJs(`(function(){
      const v = document.querySelector('#view');
      const t = document.querySelector('#pgTitle');
      return { len: v ? v.innerHTML.length : 0, title: t ? t.textContent : '', hash: location.hash };
    })()`);
    routeResults.push({ r, len: info.len, title: info.title, ok: info.len > 80 && !!info.title });
  }
  const badRoutes = routeResults.filter((x) => !x.ok);
  rec('11 条路由全部渲染', badRoutes.length === 0,
    badRoutes.length ? '异常：' + badRoutes.map((x) => x.r).join(',') : routeResults.map((x) => x.r + '→' + x.title).join(' | '));

  // 3. 390 / 820 / 1280 三档无横向溢出
  // 判定用文档 scrollWidth（真实滚动条来源）；单元素的 getBoundingClientRect 会包含
  // 被 overflow 容器裁掉、但视觉上并未溢出的子元素，因此同时排除 scroll 容器内部元素。
  for (const w of [390, 820, 1280]) {
    await viewport(w, 900);
    for (const r of ['home', 'tasks', 'todos', 'space', 'config', 'task/' + taskId]) {
      await evalJs(`location.hash = '#/${r}'`);
      await sleep(260);
      const m = await evalJs(`(function(){
        const doc = document.documentElement;
        // 找出真正把页面撑宽的元素：排除祖先里带 overflow 滚动/隐藏的
        let worst = '', maxRight = 0;
        for (const el of document.querySelectorAll('body *')) {
          const b = el.getBoundingClientRect();
          if (b.width <= 0 || b.right <= window.innerWidth + 1) continue;
          let clipped = false;
          let p = el.parentElement;
          while (p && p !== document.body) {
            const ov = getComputedStyle(p).overflowX;
            if (ov === 'auto' || ov === 'scroll' || ov === 'hidden') { clipped = true; break; }
            p = p.parentElement;
          }
          if (clipped) continue;
          if (b.right > maxRight) { maxRight = b.right; worst = el.tagName + '.' + (el.className || ''); }
        }
        return { scrollW: doc.scrollWidth, bodyW: document.body.scrollWidth, inner: window.innerWidth,
                 maxRight: Math.round(maxRight), worst: worst };
      })()`);
      rec('无横向溢出 ' + w + 'px ' + r, m.scrollW <= m.inner + 1 && m.bodyW <= m.inner + 1 && m.maxRight <= m.inner + 1,
        'scrollW=' + m.scrollW + ' bodyW=' + m.bodyW + ' inner=' + m.inner + (m.maxRight > m.inner ? ' 溢出元素=' + m.worst : ''));
    }
  }
  await viewport(390, 844);
  await evalJs(`location.hash = '#/home'`);
  await sleep(400);
  await shot('390-home');
  await viewport(820, 900);
  await sleep(300);
  await shot('820-home');
  await evalJs(`location.hash = '#/tasks'`);
  await sleep(350);
  await shot('820-tasks');
  await viewport(1280, 900);
  await sleep(300);
  await shot('1280-home');

  // 4. 待办勾选持久化
  await evalJs(`location.hash = '#/todos'`);
  await sleep(400);
  // 勾选状态按 id 持久化为 map；用 data-todo 精确定位，避免条目在「未完成/已完成」之间移动后索引漂移
  const todoBefore = await evalJs(`(function(){
    const cbs = [...document.querySelectorAll('.cbx[data-todo]')];
    if (!cbs.length) return null;
    const idx = cbs.findIndex((c) => !c.classList.contains('on'));
    const target = idx > -1 ? idx : 0;
    return { count: cbs.length, id: cbs[target].getAttribute('data-todo'),
             on: cbs[target].classList.contains('on'), raw: localStorage.getItem('ac.h5.todos') };
  })()`);
  if (!todoBefore) throw new Error('待办页无勾选框');
  await evalJs(`(function(){ var c=document.querySelector('.cbx[data-todo="${todoBefore.id}"]'); if(c) c.click(); })()`);
  await sleep(300);
  const todoAfter = await evalJs(`(function(){
    const c = document.querySelector('.cbx[data-todo="${todoBefore.id}"]');
    let stored = null;
    try { stored = JSON.parse(localStorage.getItem('ac.h5.todos') || 'null'); } catch (e) {}
    return { on: c ? c.classList.contains('on') : null,
             stored, doneRows: document.querySelectorAll('.todo.done').length };
  })()`);
  const storedIsMap = todoAfter.stored && typeof todoAfter.stored === 'object' && !Array.isArray(todoAfter.stored);
  rec('待办勾选写入 localStorage', todoAfter.on !== todoBefore.on && storedIsMap,
    '切换前 on=' + todoBefore.on + ' → 后 on=' + todoAfter.on + '，storage=' +
      (storedIsMap ? Object.keys(todoAfter.stored).length + ' 项（按 id 存储）' : 'null/格式不符'));

  await evalJs(`location.reload()`);
  await sleep(1200);
  const persisted = await evalJs(`(function(){
    const c = document.querySelector('.cbx[data-todo="${todoBefore.id}"]');
    let s = null;
    try { s = JSON.parse(localStorage.getItem('ac.h5.todos') || 'null'); } catch (e) {}
    return { stored: s, on: c ? c.classList.contains('on') : null,
             doneRows: document.querySelectorAll('.todo.done').length };
  })()`);
  const persistedMap = persisted.stored && typeof persisted.stored === 'object' && !Array.isArray(persisted.stored);
  const checkedCount = persistedMap ? Object.values(persisted.stored).filter(Boolean).length : 0;
  rec('刷新后勾选状态保持', persistedMap && persisted.on === todoAfter.on && checkedCount > 0,
    '刷新后该条目 on=' + persisted.on + '（切换后为 ' + todoAfter.on + '），storage 中已勾选 ' + checkedCount + ' 项');

  // 5. 任务详情下钻（点行进入）
  await evalJs(`location.hash = '#/tasks'`);
  await sleep(400);
  await evalJs(`(function(){var a=document.querySelector('#view a.trow');if(a)a.click();})()`);
  await sleep(500);
  const detail = await evalJs(`(function(){
    return { hash: location.hash, title: document.querySelector('#pgTitle') ? document.querySelector('#pgTitle').textContent : '',
             hasPath: document.querySelector('#view').innerHTML.indexOf('会话文件') > -1,
             len: document.querySelector('#view').innerHTML.length };
  })()`);
  rec('任务详情可下钻且显示会话源文件', detail.hash.indexOf('#/task/') === 0 && detail.hasPath,
    'hash=' + detail.hash.slice(0, 40) + ' 标题=' + detail.title + ' 含会话文件=' + detail.hasPath);
  await viewport(820, 900);
  await sleep(250);
  await shot('820-detail');

  // 6. 深色模式
  await rpc('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await viewport(820, 900);
  await evalJs(`location.hash = '#/home'`);
  await sleep(500);
  const dark = await evalJs(`(function(){
    const bg = getComputedStyle(document.body).backgroundColor;
    const doc = document.documentElement;
    return { bg: bg, scrollW: doc.scrollWidth, inner: window.innerWidth };
  })()`);
  rec('深色模式生效且无溢出', dark.scrollW <= dark.inner + 1,
    'body背景=' + dark.bg + ' scrollW=' + dark.scrollW + '/' + dark.inner);
  await shot('820-dark');
  await rpc('Emulation.setEmulatedMedia', { features: [] });

  // 7. file:// 离线演示态
  await viewport(820, 900);
  await rpc('Page.navigate', { url: 'file:///' + path.join(REPO, 'h5', 'index.html').replace(/\\/g, '/') });
  await sleep(1200);
  const offline = await evalJs(`(function(){
    const body = document.body.innerText;
    return { hasDemo: body.indexOf('演示数据') > -1, tasks: typeof TASKS !== 'undefined' ? TASKS.length : -1,
             online: typeof state !== 'undefined' ? state.online : null,
             abSub: document.querySelector('#abSub') ? document.querySelector('#abSub').textContent : '',
             rendered: document.querySelector('#view') ? document.querySelector('#view').innerHTML.length : 0 };
  })()`);
  rec('离线 file:// 正常渲染并标注演示数据', offline.hasDemo && offline.rendered > 100 && offline.tasks > 0,
    '演示标注=' + offline.hasDemo + ' 任务=' + offline.tasks + ' 渲染长度=' + offline.rendered + ' 状态=' + offline.abSub);

  rec('无未捕获异常 / 控制台错误', errors.length === 0, errors.length ? errors.slice(0, 3).join(' | ') : '干净');
} catch (e) {
  rec('执行未中断', false, e.message);
} finally {
  try { if (ws) ws.close(); } catch {}
  edge.kill();
  srv.kill();
  await sleep(500);
  try { fs.rmSync(userDir, { recursive: true, force: true }); } catch {}
}

let fails = 0;
console.log('\nH5 浏览器验收（Edge headless / CDP）\n' + '─'.repeat(70));
for (const r of results) {
  if (!r.pass) fails++;
  console.log((r.pass ? 'PASS ' : 'FAIL ') + r.name + (r.msg ? '  ·  ' + r.msg : ''));
}
console.log('─'.repeat(70));
console.log((results.length - fails) + ' / ' + results.length + ' 通过' + (fails ? '，' + fails + ' 项失败' : '，全部通过'));
console.log('截图目录：' + SHOTS);
process.exit(fails ? 1 : 0);
