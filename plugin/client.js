/**
 * Client half of the AgentCenter bundle.
 *
 * - `sidebar.panellist.actions` — one row in the left panel list's More menu,
 *   shown only while the plugin's `showInMore` config is true.
 * - `main` (key `agentcenter`) — the AgentCenter page: a start gate while the
 *   local service is down, the real page in an embedded frame once it runs.
 * - `conversation.input.left` — a composer control that inserts a previous
 *   session's transcript into the draft, picked from the AgentCenter index.
 *
 * The frame talks to this page over a small postMessage protocol
 * (`agentcenter-h5` request / `dsh-agentcenter` response); every DSH operation
 * it asks for (open a Session, create one and import a transcript, read the
 * link table) runs here, where the Client services live.
 *
 * Markup and CSS follow the host's own controls; only `--dsw-*` theme tokens
 * are referenced.
 */
window.__ModuleLoader__.load({
  id: 'dsh-agentcenter',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState } = React;

    const NS = 'agentCenter';
    const PANEL = 'agentcenter';
    const COMPOSER_ID = 'agentcenter-reference';
    const PICKER_OVERLAY_ID = 'agentcenter-picker';

    const en = {
      'entry.label': 'AgentCenter',
      'entry.menu': 'AgentCenter',
      'page.title': 'AgentCenter · Agent task center',
      'page.description':
        'Every AI agent session on this machine in one place: what they did, what they left unfinished, and how much disk they occupy.',
      'action.start': 'Start service',
      'action.starting': 'Starting…',
      'action.stopping': 'Stopping…',
      'action.refresh': 'Reload',
      'action.scan': 'Scan now',
      'action.scanning': 'Scanning\u2026',
      'status.connected': 'Local service connected',
      'status.lastScan': 'last scan',
      'action.stop': 'Stop service',
      'state.checking': 'Checking the local service…',
      'hint.service': 'Local service',
      'hint.readonly': 'Read-only scan · this machine only',
      'note.demo':
        'No data/summary.json yet, so the page falls back to sample data. Run node cli/agentcenter.mjs scan to build the real index.',
      'frame.failed': 'The page did not load. Reload it to try again.',
      'composer.open': 'Reference a previous session',
      'composer.title': 'Reference a previous session',
      'composer.hint': 'Paste a session from the AgentCenter index into the composer as context.',
      'composer.search': 'Search title, project, or directory',
      'composer.empty': 'No matching sessions',
      'composer.loading': 'Reading the session…',
      'composer.insert': 'Insert',
      'composer.cancel': 'Cancel',
      'composer.ready': 'Ready to insert',
      'composer.preamble': 'Context from an earlier AgentCenter session:',
      'composer.inserted': 'Inserted into the composer',
      'composer.failed': 'Could not insert into the composer',
      'composer.needSession': 'Open a session first',
      'composer.filterAgent': 'Filter by agent',
      'composer.allAgents': 'All agents',
      'composer.intro': 'An earlier AgentCenter session, exported read-only. Read the file when you need it:',
      'composer.ruleIntro': 'Parsing rules for that file format:',
      'continue.intro': 'Continue this earlier session. The workspace defaults to the directory it ran in; read these files when you need them:',
      'settings.label': 'AgentCenter',
      'settings.title': 'AgentCenter',
      'settings.lead': 'The switches below live in this profile\u2019s plugin configuration and take effect right away.',
      'settings.showInMore': 'Combine into the More menu',
      'settings.showInMore.desc': 'On: the entry sits inside the left panel list\u2019s More menu. Off: it shows as its own panel row right above More.',
      'settings.showInComposer': 'Show the composer reference control',
      'settings.showInComposer.desc': 'The button left of the message input that inserts an earlier session\u2019s transcript into the draft.',
      'settings.port': 'Local service port',
      'settings.port.desc': 'The port the panel\u2019s Start service listens on. Default 7788. Changing it restarts the plugin.',
      'settings.root': 'AgentCenter directory',
      'settings.root.desc': 'Advanced: point at a source checkout that holds h5/serve.mjs. Leave empty to use the copy bundled with the package.',
      'settings.dataDir': 'Data directory',
      'settings.dataDir.desc': 'Index, reports, exports and links live here. Empty means ~/.agentcenter, which plugin upgrades never touch.',
      'settings.dataDir.short': 'data dir',
      'settings.resolved': 'Runtime',
      'settings.dataResolved': 'Data',
      'settings.service': 'Service',
      'settings.unavailable': 'This profile cannot save plugin configuration; edit the profile\u2019s config layer instead.',
      'settings.invalidPort': 'Port must be an integer between 1 and 65535',
      'settings.saved': 'Saved',
      'settings.saveFailed': 'Saved, but the new value did not take effect',
      'settings.saving': 'Saving…',
      'settings.aiTitle': 'AI daily report',
      'settings.aiLead': 'Uses the models DSH already configured (provider and key come from DSH). Pick one model and shape the report format.',
      'settings.reportModel': 'Model',
      'settings.reportModel.desc': 'Choose a provider and model from the DSH model list.',
      'settings.reportModel.none': 'Not selected',
      'settings.modelsEmpty': 'DSH reported no models. Configure a provider under Settings → Models first.',
      'settings.reportFormat': 'Report format',
      'settings.reportFormat.desc': 'The model fills this skeleton with the real data of the day. Empty means the built-in by-project template.',
      'settings.reportFormat.reset': 'Use default',
      'settings.reportFormat.save': 'Save format',
    };
    const zh = {
      'entry.label': 'AgentCenter',
      'entry.menu': 'AgentCenter',
      'page.title': 'AgentCenter · Agent 任务中心',
      'page.description': '统一查看本机各 AI Agent 的会话：干了什么、哪些没做完、一共占了多少本地空间。',
      'action.start': '启动服务',
      'action.starting': '正在启动…',
      'action.stopping': '正在停止…',
      'action.refresh': '刷新',
      'action.scan': '立即扫描',
      'action.scanning': '正在扫描…',
      'status.connected': '本地服务已连接',
      'status.lastScan': '上次扫描',
      'action.stop': '停止服务',
      'state.checking': '正在检查本地服务…',
      'hint.service': '本地服务',
      'hint.readonly': '只读扫描 · 仅本机访问',
      'note.demo': '尚未生成 data/summary.json，页面会回退到演示数据。运行 node cli/agentcenter.mjs scan 生成真实索引。',
      'frame.failed': '页面没有加载出来，可以刷新重试。',
      'composer.open': '引用历史会话',
      'composer.title': '引用历史会话',
      'composer.hint': '把 AgentCenter 索引里的一段会话内容插入输入框，作为本轮对话的上下文。',
      'composer.search': '搜索标题、项目或目录',
      'composer.empty': '没有匹配的会话',
      'composer.loading': '正在读取会话内容…',
      'composer.insert': '插入',
      'composer.cancel': '取消',
      'composer.ready': '已就绪，可插入',
      'composer.preamble': '以下是 AgentCenter 中另一段历史会话的内容，供本轮参考：',
      'composer.inserted': '已插入输入框',
      'composer.failed': '插入输入框失败',
      'composer.needSession': '请先打开一个会话',
      'composer.filterAgent': '按 Agent 筛选',
      'composer.allAgents': '全部 Agent',
      'composer.intro': '这是 AgentCenter 里的一段历史会话（只读导出），需要时请读取这个文件：',
      'composer.ruleIntro': '该文件格式的解析规则：',
      'continue.intro': '继续这段历史会话。工作区已设为它当时的工作目录，需要时请读取这些文件：',
      'settings.label': 'AgentCenter',
      'settings.title': 'AgentCenter',
      'settings.lead': '下面这些开关存在当前 profile 的插件配置里，改完立即生效。',
      'settings.showInMore': '放入更多中',
      'settings.showInMore.desc': '选中时入口收在左侧「全局面板」的「更多」菜单里；不选则作为独立面板行显示在「更多」上方。',
      'settings.showInComposer': '输入区显示「引用历史会话」',
      'settings.showInComposer.desc': '消息输入框左侧那个按钮，用来把某段历史会话的内容插入当前草稿。',
      'settings.port': '本地服务端口',
      'settings.port.desc': '面板里「启动服务」监听的端口，默认 7788。改动会重启插件后生效。',
      'settings.root': 'AgentCenter 目录',
      'settings.root.desc': '高级用法：指向含 h5/serve.mjs 的源码仓库；留空则用包里自带的那份运行时。',
      'settings.dataDir': '数据目录',
      'settings.dataDir.desc': '索引、日报、引用导出与关联表都写在这里；留空用 ~/.agentcenter，升级插件不会动它。',
      'settings.dataDir.short': '数据',
      'settings.resolved': '运行时',
      'settings.dataResolved': '数据',
      'settings.service': '服务',
      'settings.unavailable': '当前 profile 不支持保存插件配置，请改 profile 的配置层。',
      'settings.invalidPort': '端口必须是 1–65535 的整数',
      'settings.saved': '已保存',
      'settings.saveFailed': '已写入，但没有生效',
      'settings.saving': '正在保存…',
      'settings.aiTitle': 'AI 日报',
      'settings.aiLead': '用的是 DSH 里已配置的模型（provider 与 key 都由 DSH 提供），这里只选一个模型、定一下日报格式。',
      'settings.reportModel': '日报模型',
      'settings.reportModel.desc': '从 DSH 的模型列表里选一个。',
      'settings.reportModel.none': '未选择',
      'settings.modelsEmpty': 'DSH 没有报告任何模型，先去 设置 → 模型 里配一个 provider。',
      'settings.reportFormat': '日报格式',
      'settings.reportFormat.desc': '模型按这个骨架填入当天真实数据；留空则用内置的「按项目总结」模板。',
      'settings.reportFormat.reset': '恢复默认',
      'settings.reportFormat.save': '保存格式',
    };

    const prefersZh =
      typeof navigator !== 'undefined' && typeof navigator.language === 'string' && navigator.language.toLowerCase().startsWith('zh');
    const fallback = (key) => (prefersZh ? zh[key] ?? en[key] : en[key] ?? zh[key]) ?? key;
    const translator = (props) => (typeof props?.t === 'function' ? props.t : fallback);

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    /** ISO 串或数字 → 毫秒；不可用为 0。 */
    const millis = (value) => {
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      const parsed = Date.parse(String(value ?? ''));
      return Number.isFinite(parsed) ? parsed : 0;
    };

    /** Resolve one Host route against the page's own base, keeping any reverse-proxy prefix. */
    function routeUrl(route) {
      const raw = typeof document !== 'undefined' ? document.baseURI : '';
      let base = 'http://dsh.invalid/';
      if (raw) {
        try {
          const url = new URL(raw);
          url.search = '';
          url.hash = '';
          if (!url.pathname.endsWith('/')) url.pathname = url.pathname.replace(/[^/]*$/, '');
          base = url.href;
        } catch {
          /* keep the placeholder */
        }
      }
      return new URL(route.replace(/^\/+/, ''), base);
    }

    async function call(route, init) {
      const response = await fetch(routeUrl(route), {
        ...init,
        headers: { accept: 'application/json', ...(init && init.body ? { 'content-type': 'application/json' } : {}) },
        credentials: 'same-origin',
      });
      let body = {};
      try {
        const parsed = await response.json();
        if (typeof parsed === 'object' && parsed !== null) body = parsed;
      } catch {
        /* non-JSON answer */
      }
      return { status: response.status, ok: response.ok, body };
    }

    const post = (route, payload) => call(route, { method: 'POST', body: JSON.stringify(payload) });

    /** Minimal external store: one identity-stable snapshot per change. */
    function createStore(initial) {
      let state = initial;
      const listeners = new Set();
      return {
        getSnapshot: () => state,
        subscribe(fn) {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
        set(patch) {
          state = { ...state, ...patch };
          for (const fn of [...listeners]) fn();
        },
      };
    }

    function useStore(store) {
      return React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    }

    function Mark({ size = 56 }) {
      return h(
        'svg',
        { viewBox: '0 0 64 64', width: size, height: size, 'aria-hidden': 'true', focusable: 'false' },
        h('rect', { x: 3, y: 3, width: 58, height: 58, rx: 15, fill: '#3B82F6' }),
        h(
          'g',
          { stroke: '#FFFFFF', strokeWidth: 4.6, strokeLinecap: 'round' },
          h('path', { d: 'M17 21h21' }),
          h('path', { d: 'M17 32h29' }),
          h('path', { d: 'M17 43h16' }),
        ),
        h('circle', { cx: 47, cy: 21, r: 4.4, fill: '#7DE2C3' }),
      );
    }

    const CSS = `
.dshac-root{box-sizing:border-box;display:flex;flex-direction:column;width:100%;height:100%;min-width:0;min-height:0;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font-size:14px;line-height:1.55;font-family:inherit;overflow:hidden}
.dshac-hero{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;padding:32px 24px;overflow:auto}
.dshac-card{width:100%;max-width:430px;display:flex;flex-direction:column;align-items:center;text-align:center;gap:12px}
.dshac-mark{display:inline-flex;border-radius:16px;flex:none;box-shadow:0 8px 24px rgba(59,130,246,.22)}
.dshac-title{margin:2px 0 0;font-size:17px;font-weight:600;letter-spacing:.1px}
.dshac-desc{margin:0;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-secondary);max-width:360px}
.dshac-actions{margin-top:6px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;justify-content:center}
.dshac-primary{height:34px;padding:0 20px;border:0;border-radius:var(--dsw-radius-md,9px);background:var(--dsw-alias-brand-primary,#3b82f6);color:#fff;font:inherit;font-size:13px;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;gap:8px;transition:filter .15s ease}
.dshac-primary:hover:not(:disabled){filter:brightness(1.06)}
.dshac-primary:disabled{opacity:.62;cursor:default}
.dshac-ghost{box-sizing:border-box;height:28px;padding:0 10px;border-radius:var(--dsw-radius-md,8px);border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;white-space:nowrap}
.dshac-ghost:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary)}
.dshac-ghost:disabled{opacity:.55;cursor:default}
.dshac-hint{font-size:12px;color:var(--dsw-alias-label-secondary);display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:center}
.dshac-sep{opacity:.5}
.dshac-error{margin-top:2px;font-size:12.5px;line-height:1.5;color:var(--dsw-alias-state-error-primary);max-width:380px;word-break:break-word}
.dshac-bar{flex:none;display:flex;align-items:center;gap:10px;padding:6px 12px;border-bottom:.5px solid var(--dsw-alias-border-l1);min-width:0}
.dshac-bar .dshac-meta{min-width:0;overflow:hidden;text-overflow:ellipsis}
.dshac-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-success-primary,#22c55e);flex:none}
.dshac-name{font-size:13px;font-weight:600;white-space:nowrap}
.dshac-meta{font-size:12px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap}
.dshac-fill{flex:1;min-width:8px}
.dshac-note{flex:none;padding:5px 12px;font-size:12px;line-height:1.5;color:var(--dsw-alias-state-warn-primary);border-bottom:.5px solid var(--dsw-alias-border-l1)}
.dshac-frameWrap{position:relative;flex:1;min-height:0;display:flex;background:var(--dsw-alias-bg-base)}
.dshac-frame{flex:1;min-height:0;width:100%;border:0;display:block;background:var(--dsw-alias-bg-base)}
.dshac-veil{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:24px;text-align:center;background:var(--dsw-alias-bg-base)}
.dshac-spinner{width:15px;height:15px;border-radius:50%;border:2px solid currentColor;border-top-color:transparent;animation:dshac-spin .8s linear infinite;opacity:.65;flex:none}
@keyframes dshac-spin{to{transform:rotate(360deg)}}
.dshac-menuItem{border-radius:var(--dsw-radius-md,8px);cursor:pointer;width:100%;min-height:34px;color:var(--dsw-alias-label-primary);text-align:left;background:0 0;border:none;align-items:center;gap:6px;padding:6px 8px;font-size:13px;line-height:20px;display:flex;font-family:inherit}
@media (hover:hover){.dshac-menuItem:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}}
.dshac-menuItem:focus-visible{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));outline:none}
.dshac-menuIcon{width:14px;height:14px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));flex:none;display:inline-flex;align-items:center;justify-content:center}
.dshac-menuIcon svg{width:14px;height:14px}
.dshac-menuLabel{text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;overflow:hidden}
/* composer control */
.dshac-tool{height:28px;min-width:28px;padding:0 7px;border:0;border-radius:var(--dsw-radius-md,8px);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;display:inline-flex;align-items:center;gap:5px}
.dshac-tool:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary)}
.dshac-tool svg{width:15px;height:15px;flex:none}
/* picker overlay */
.dshac-scrim{position:fixed;inset:0;background:rgba(0,0,0,.34);display:flex;align-items:flex-start;justify-content:center;padding:12vh 16px 24px;z-index:60;pointer-events:auto}
.dshac-sheet{box-sizing:border-box;width:100%;max-width:560px;max-height:72vh;display:flex;flex-direction:column;background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1));border:1px solid var(--dsw-alias-border-l1);border-radius:12px;box-shadow:0 24px 60px rgba(0,0,0,.28);overflow:hidden;color:var(--dsw-alias-label-primary)}
.dshac-sheetHead{flex:none;padding:14px 16px 10px;border-bottom:.5px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column;gap:3px}
.dshac-sheetTitle{font-size:14px;font-weight:600}
.dshac-sheetHint{font-size:12px;color:var(--dsw-alias-label-secondary)}
.dshac-search{flex:none;display:flex;gap:8px;padding:10px 16px;border-bottom:.5px solid var(--dsw-alias-border-l1)}
.dshac-input{flex:1;min-width:0;height:30px;box-sizing:border-box;padding:0 10px;border-radius:var(--dsw-radius-md,8px);border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none}
.dshac-input:focus{border-color:var(--dsw-alias-border-l2)}
.dshac-list{flex:1;min-height:120px;overflow:auto;padding:6px}
.dshac-row{display:flex;flex-direction:column;gap:2px;width:100%;text-align:left;padding:8px 10px;border:0;border-radius:var(--dsw-radius-md,8px);background:transparent;color:inherit;font:inherit;cursor:pointer}
.dshac-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dshac-row[data-active="1"]{background:var(--dsw-alias-interactive-bg-selected,rgba(59,130,246,.16))}
.dshac-rowTitle{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshac-rowMeta{font-size:11.5px;color:var(--dsw-alias-label-secondary);display:flex;gap:8px;flex-wrap:wrap}
.dshac-foot{flex:none;display:flex;align-items:center;gap:10px;padding:10px 16px;border-top:.5px solid var(--dsw-alias-border-l1)}
.dshac-footInfo{flex:1;min-width:0;font-size:12px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* settings page */
.dshac-settings{display:flex;flex-direction:column;gap:12px;padding:2px 2px 28px;max-width:680px;color:var(--dsw-alias-label-primary)}
.dshac-settingsTitle{margin:0;font-size:15px;font-weight:600}
.dshac-settingsLead{margin:0;font-size:12.5px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
.dshac-setting{display:flex;align-items:flex-start;gap:16px;padding:11px 0;border-bottom:.5px solid var(--dsw-alias-border-l1)}
.dshac-setting[data-block="1"]{flex-direction:column;gap:8px}
.dshac-setting:last-of-type{border-bottom:0}
.dshac-settingText{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.dshac-settingTitle{font-size:13px;font-weight:600}
.dshac-settingDesc{font-size:12px;line-height:1.55;color:var(--dsw-alias-label-secondary);max-width:520px}
.dshac-settingControl{flex:none;display:flex;align-items:center;gap:8px;justify-content:flex-end}
.dshac-switch{position:relative;width:34px;height:20px;border-radius:10px;border:0;padding:0;cursor:pointer;background:var(--dsw-alias-border-l2,rgba(127,127,127,.45));transition:background .15s ease;flex:none}
.dshac-switch[data-on="1"]{background:var(--dsw-alias-brand-primary,#3b82f6)}
.dshac-switch:disabled{opacity:.5;cursor:default}
.dshac-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .15s ease;box-shadow:0 1px 2px rgba(0,0,0,.25)}
.dshac-switch[data-on="1"] .dshac-knob{transform:translateX(14px)}
.dshac-field{box-sizing:border-box;height:30px;padding:0 10px;border-radius:var(--dsw-radius-md,8px);border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;outline:none}
.dshac-field:focus{border-color:var(--dsw-alias-border-l2)}
.dshac-field[data-wide="1"]{width:100%}
.dshac-field[data-narrow="1"]{width:110px;text-align:right}
.dshac-field[data-select="1"]{width:auto;max-width:170px;text-align:left;padding:0 6px}
.dshac-settingsFoot{display:flex;flex-direction:column;gap:3px;font-size:12px;line-height:1.55;color:var(--dsw-alias-label-secondary)}
.dshac-settingsFoot b{font-weight:600;color:var(--dsw-alias-label-primary)}
.dshac-settingsError{color:var(--dsw-alias-state-error-primary)}
.dshac-settingsOk{color:var(--dsw-alias-state-success-primary)}
.dshac-formatBox{display:flex;flex-direction:column;gap:8px;width:100%}
.dshac-textarea{height:auto;min-height:120px;padding:8px 10px;line-height:1.55;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;resize:vertical;white-space:pre;overflow:auto}
.dshac-formatActions{display:flex;gap:8px;justify-content:flex-end}
`;

    /** Monochrome glyph for host chrome (sidebar row / menu row): follows currentColor. */
    function Glyph({ size = 16 }) {
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('path', { d: 'M4 7h12' }),
        h('path', { d: 'M4 12h16' }),
        h('path', { d: 'M4 17h9' }),
        h('circle', { cx: 19.5, cy: 7, r: 2.1, fill: 'currentColor', stroke: 'none' }),
      );
    }

    /** The sidebar panel row, used when the entry is not combined into More. */
    function PanelEntry({ size }) {
      return h(Glyph, { size: size ?? 16 });
    }

    /** The sidebar panel-list More row: close the menu, then open the page. */
    function MoreEntry(props) {
      const { open, onDismiss } = props;
      const t = translator(props);
      return h(
        React.Fragment,
        null,
        h('style', { key: 'style' }, CSS),
        h(
          'button',
          {
            key: 'row',
            type: 'button',
            role: 'menuitem',
            className: 'dshac-menuItem',
            onClick: () => {
              onDismiss();
              open();
            },
          },
          h('span', { className: 'dshac-menuIcon' }, h(Glyph, { size: 14 })),
          h('span', { className: 'dshac-menuLabel' }, t('entry.label')),
        ),
      );
    }

    /** The page: a start gate while the service is stopped, the real UI while it runs. */
    function AgentCenterPage(props) {
      const t = translator(props);
      const bridge = props.bridge;
      const [phase, setPhase] = useState('checking');
      const [status, setStatus] = useState(null);
      const [error, setError] = useState('');
      const [frameKey, setFrameKey] = useState(0);
      const [frame, setFrame] = useState('loading');
      const [scanning, setScanning] = useState(false);
      const frameRef = useRef(null);
      const mounted = useRef(true);
      const lastGenerated = useRef('');
      // 工作区快照：继续对话要按任务的工作目录找（或建）工作区
      const workspaceSnapshot = typeof props.useWorkspaces === 'function' ? props.useWorkspaces((snapshot) => snapshot) : null;
      useEffect(() => {
        if (bridge !== undefined) bridge.workspaces = workspaceSnapshot;
      }, [bridge, workspaceSnapshot]);

      useEffect(() => {
        mounted.current = true;
        return () => {
          mounted.current = false;
        };
      }, []);

      const accept = useCallback((body) => {
        if (body && typeof body === 'object') {
          setStatus(body);
          if (body.error) setError(String(body.error));
        }
        return body;
      }, []);

      const check = useCallback(
        async (quiet) => {
          if (!quiet) setPhase('checking');
          try {
            const result = await call('/api/agentcenter/status', { method: 'GET' });
            if (!mounted.current) return;
            const body = accept(result.body);
            if (!result.ok) {
              setError(body.error || `HTTP ${result.status}`);
              setPhase('stopped');
              return;
            }
            setPhase(body.running === true ? 'running' : 'stopped');
            // 定时扫描会改写索引：generatedAt 变了就通知页面刷新数据（5 分钟一轮也能看到新状态）
            const generatedAt = body.health && typeof body.health.generatedAt === 'string' ? body.health.generatedAt : '';
            if (generatedAt !== '') {
              if (lastGenerated.current !== '' && lastGenerated.current !== generatedAt) {
                bridge.notify('scanned', { at: generatedAt });
              }
              lastGenerated.current = generatedAt;
            }
          } catch (failure) {
            if (!mounted.current) return;
            setError(failure instanceof Error ? failure.message : String(failure));
            setPhase('stopped');
          }
        },
        [accept],
      );

      const run = useCallback(
        async (action) => {
          setError('');
          setPhase(action === 'start' ? 'starting' : 'stopping');
          try {
            const result = await call(`/api/agentcenter/${action}`, { method: 'POST' });
            if (!mounted.current) return;
            const body = accept(result.body);
            if (!result.ok || body.ok !== true) {
              setPhase(body.running === true ? 'running' : 'stopped');
              setError(String(body.error || `HTTP ${result.status}`));
              return;
            }
            if (body.running === true) {
              setFrame('loading');
              setFrameKey((key) => key + 1);
              setPhase('running');
            } else {
              setPhase('stopped');
            }
          } catch (failure) {
            if (!mounted.current) return;
            setError(failure instanceof Error ? failure.message : String(failure));
            setPhase('stopped');
          }
        },
        [accept],
      );

      useEffect(() => {
        check(false);
      }, [check]);

      // Keep watching while open, so an externally stopped service returns the gate.
      useEffect(() => {
        if (phase !== 'running') return undefined;
        const timer = setInterval(() => check(true), 6000);
        return () => clearInterval(timer);
      }, [phase, check]);

      // A frame that never reports load is not "still loading" for the reader.
      useEffect(() => {
        if (phase !== 'running' || frame !== 'loading') return undefined;
        const timer = setTimeout(() => {
          if (mounted.current) setFrame((current) => (current === 'loading' ? 'failed' : current));
        }, 9000);
        return () => clearTimeout(timer);
      }, [phase, frame, frameKey]);

      // The frame may only answer this page's own window.
      useEffect(() => {
        if (bridge === undefined) return undefined;
        bridge.frame = phase === 'running' ? frameRef : null;
        return () => {
          if (bridge.frame === frameRef) bridge.frame = null;
        };
      }, [bridge, phase]);

      const reload = useCallback(() => {
        setFrame('loading');
        setFrameKey((key) => key + 1);
      }, []);

      /** 立即扫描：跑一轮（宿主进程内），再让 iframe 重新加载新索引。 */
      const scan = useCallback(async () => {
        setScanning(true);
        setError('');
        try {
          const result = await post('/api/agentcenter/scan', {});
          if (!result.ok || !result.body || result.body.ok !== true) {
            setError(String(result.body?.error || `HTTP ${result.status}`));
          }
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure));
        }
        if (!mounted.current) return;
        setScanning(false);
        await check(true);
        reload();
      }, [check, reload]);

      const busy = phase === 'starting' || phase === 'stopping';
      const url = status && typeof status.url === 'string' ? status.url : '';
      const health = status && status.health && typeof status.health === 'object' ? status.health : null;
      const lastScan = health && typeof health.lastScan === 'string' && health.lastScan !== '' ? health.lastScan : '';

      if (phase === 'running') {
        return h(
          'div',
          { className: 'dshac-root' },
          h('style', { key: 'style' }, CSS),
          h(
            'div',
            { className: 'dshac-bar' },
            h('span', { className: 'dshac-dot' }),
            h('span', { className: 'dshac-name' }, t('entry.label')),
            h('span', { className: 'dshac-meta' }, `127.0.0.1:${status.port ?? ''}`),
            h('span', { className: 'dshac-fill' }),
            // 连接状态 + 上次扫描 + 立即扫描：放在顶部工具条、刷新按钮之前
            h(
              'span',
              { className: 'dshac-meta' },
              lastScan === '' ? t('status.connected') : `${t('status.connected')} · ${t('status.lastScan')} ${lastScan}`,
            ),
            h(
              'button',
              { type: 'button', className: 'dshac-ghost', disabled: scanning, onClick: scan },
              scanning ? t('action.scanning') : t('action.scan'),
            ),
            h('button', { type: 'button', className: 'dshac-ghost', onClick: reload }, t('action.refresh')),
            h(
              'button',
              { type: 'button', className: 'dshac-ghost', disabled: busy, onClick: () => run('stop') },
              busy ? t('action.stopping') : t('action.stop'),
            ),
          ),
          status.hasIndex === false && h('div', { className: 'dshac-note' }, t('note.demo')),
          error && h('div', { className: 'dshac-note dshac-error' }, error),
          h(
            'div',
            { className: 'dshac-frameWrap' },
            url !== '' &&
              h('iframe', {
                key: `frame-${frameKey}`,
                ref: frameRef,
                className: 'dshac-frame',
                src: url,
                title: 'AgentCenter',
                onLoad: () => setFrame('ready'),
              }),
            frame !== 'ready' &&
              h(
                'div',
                { className: 'dshac-veil' },
                frame === 'loading'
                  ? h(
                      React.Fragment,
                      null,
                      h('span', { className: 'dshac-spinner' }),
                      h('span', { className: 'dshac-hint' }, t('state.checking')),
                    )
                  : h(
                      React.Fragment,
                      null,
                      h('div', { className: 'dshac-desc' }, t('frame.failed')),
                      h(
                        'div',
                        { className: 'dshac-actions' },
                        h('button', { type: 'button', className: 'dshac-primary', onClick: reload }, t('action.refresh')),
                      ),
                    ),
              ),
          ),
        );
      }

      return h(
        'div',
        { className: 'dshac-root' },
        h('style', { key: 'style' }, CSS),
        h(
          'div',
          { className: 'dshac-hero' },
          h(
            'div',
            { className: 'dshac-card' },
            h('span', { className: 'dshac-mark' }, h(Mark, { size: 56 })),
            h('h2', { className: 'dshac-title' }, t('page.title')),
            h('p', { className: 'dshac-desc' }, t('page.description')),
            h(
              'div',
              { className: 'dshac-actions' },
              phase === 'checking'
                ? h(
                    React.Fragment,
                    null,
                    h('span', { className: 'dshac-spinner' }),
                    h('span', { className: 'dshac-hint' }, t('state.checking')),
                  )
                : h(
                    'button',
                    { type: 'button', className: 'dshac-primary', disabled: busy, onClick: () => run('start') },
                    busy && h('span', { className: 'dshac-spinner' }),
                    busy ? t('action.starting') : t('action.start'),
                  ),
            ),
            h(
              'div',
              { className: 'dshac-hint' },
              h('span', null, `${t('hint.service')} 127.0.0.1:${status && status.port ? status.port : 7788}`),
              h('span', { className: 'dshac-sep' }, '·'),
              h('span', null, t('hint.readonly')),
            ),
            error ? h('div', { className: 'dshac-error' }, error) : null,
          ),
        ),
      );
    }

    /** Settings → AgentCenter: the plugin's own switches, saved through the Host config editor. */
    function AgentCenterSettings(props) {
      const t = translator(props);
      const mounted = useRef(true);
      const [state, setState] = useState({
        ready: false,
        savable: true,
        busy: '',
        note: '',
        error: '',
        service: '',
        resolved: { root: '', port: '', dataDir: '' },
        models: [],
        defaultFormat: '',
        fields: { showInMore: true, showInComposer: true, port: '', root: '', dataDir: '', reportModel: '', reportFormat: '' },
        saved: { port: '', root: '' },
      });
      /* 两个开关的「已保存值」，供乐观应用失败时回滚 */
      const savedFlags = useRef({ showInMore: true, showInComposer: true });

      useEffect(() => {
        mounted.current = true;
        return () => {
          mounted.current = false;
        };
      }, []);

      const readConfig = useCallback(async (quiet) => {
        try {
          const result = await call('/api/agentcenter/config', { method: 'GET' });
          const body = result.ok && result.body ? result.body : {};
          if (!mounted.current) return;
          const config = body.config || {};
          const saved = {
            port: Number(config.port) > 0 ? String(config.port) : '',
            root: typeof config.root === 'string' ? config.root : '',
            dataDir: typeof config.dataDir === 'string' ? config.dataDir : '',
          };
          savedFlags.current = { showInMore: config.showInMore !== false, showInComposer: config.showInComposer !== false };
          setState((prev) => ({
            ...prev,
            ready: true,
            savable: body.savable !== false,
            service: body.running === true ? `运行中 · ${body.url || ''}` : '未启动',
            resolved: { root: body.root || '', port: body.port || '', dataDir: body.dataDir || '' },
            fields: {
              showInMore: savedFlags.current.showInMore,
              showInComposer: savedFlags.current.showInComposer,
              port: saved.port,
              root: saved.root,
              dataDir: typeof config.dataDir === 'string' ? config.dataDir : '',
              reportModel: typeof config.reportModel === 'string' ? config.reportModel : '',
              reportFormat: typeof config.reportFormat === 'string' ? config.reportFormat : '',
            },
            saved,
            error: quiet ? prev.error : '',
          }));
        } catch (failure) {
          if (!mounted.current) return;
          setState((prev) => ({ ...prev, ready: true, error: String(failure?.message ?? failure) }));
        }
      }, []);

      useEffect(() => {
        readConfig(false);
        // 模型清单来自 DSH 自己（provider × 模型），可能要走一次模型发现，故单独异步拉
        call('/api/agentcenter/models', { method: 'GET' })
          .then((result) => {
            if (!mounted.current) return;
            const body = result.ok && result.body ? result.body : {};
            setState((prev) => ({
              ...prev,
              models: Array.isArray(body.items) ? body.items : [],
              defaultFormat: typeof body.defaultFormat === 'string' ? body.defaultFormat : '',
            }));
          })
          .catch(() => {});
      }, [readConfig]);

      const save = useCallback(
        async (patch, label) => {
          // 入口开关先乐观生效（不必等写入 + 插件重载），失败再回滚。
          const flags = {};
          for (const key of ['showInMore', 'showInComposer']) {
            if (Object.hasOwn(patch, key)) flags[key] = patch[key];
          }
          const hasFlags = Object.keys(flags).length > 0;
          const before = { ...savedFlags.current };
          const applyConfig = typeof props.applyConfig === 'function' ? props.applyConfig : null;
          if (hasFlags && applyConfig !== null) applyConfig(flags);

          const revert = () => {
            if (!hasFlags) return;
            if (applyConfig !== null) applyConfig(before);
            if (mounted.current) {
              setState((prev) => ({ ...prev, fields: { ...prev.fields, showInMore: before.showInMore, showInComposer: before.showInComposer } }));
            }
          };

          setState((prev) => ({ ...prev, busy: label, note: '', error: '' }));
          let failure = '';
          try {
            const result = await post('/api/agentcenter/settings', patch);
            if (result.ok && result.body && result.body.ok === false) failure = String(result.body.error || t('settings.saveFailed'));
          } catch {
            // 写入会重启本插件，请求可能被中断：交给下面的回读确认。
          }
          if (failure !== '') {
            revert();
            if (mounted.current) setState((prev) => ({ ...prev, busy: '', error: failure }));
            return;
          }
          for (let attempt = 0; attempt < 16; attempt += 1) {
            await sleep(400);
            try {
              const check = await call('/api/agentcenter/config', { method: 'GET' });
              const config = (check.body && check.body.config) || {};
              const matches = Object.keys(patch).every((key) => {
                if (key === 'port') return Number(config.port || 0) === Number(patch.port);
                if (key === 'root') return String(config.root || '') === String(patch.root || '');
                return (config[key] !== false) === (patch[key] !== false);
              });
              if (!matches) continue;
              if (hasFlags) savedFlags.current = { ...before, ...flags };
              if (mounted.current) setState((prev) => ({ ...prev, busy: '', note: `${label} · ${t('settings.saved')}` }));
              await readConfig(true);
              return;
            } catch {
              /* 插件重启中，继续等 */
            }
          }
          if (mounted.current) {
            if (hasFlags) revert();
            setState((prev) => ({ ...prev, busy: '', error: `${label} · ${t('settings.saveFailed')}` }));
          }
        },
        [props, readConfig, t],
      );

      const disabled = state.busy !== '';

      const toggle = (key) => (value) => {
        if (disabled) return;
        setState((prev) => ({ ...prev, fields: { ...prev.fields, [key]: value } }));
        void save({ [key]: value }, t(key === 'showInMore' ? 'settings.showInMore' : 'settings.showInComposer'));
      };

      const commitPort = () => {
        if (disabled) return;
        const raw = String(state.fields.port).trim();
        const port = raw === '' ? 7788 : Number(raw);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          setState((prev) => ({ ...prev, error: t('settings.invalidPort') }));
          return;
        }
        if (String(port) === state.saved.port) return;
        setState((prev) => ({ ...prev, fields: { ...prev.fields, port: String(port) } }));
        void save({ port }, t('settings.port'));
      };

      const commitRoot = () => {
        if (disabled) return;
        const next = String(state.fields.root).trim();
        if (next === state.saved.root) return;
        void save({ root: next }, t('settings.root'));
      };

      const commitDataDir = () => {
        if (disabled) return;
        const next = String(state.fields.dataDir).trim();
        if (next === (state.saved.dataDir || '')) return;
        void save({ dataDir: next }, t('settings.dataDir'));
      };

      const row = (title, desc, control, block) =>
        h(
          'div',
          { className: 'dshac-setting', 'data-block': block ? '1' : '0', key: title },
          h('div', { className: 'dshac-settingText' }, h('div', { className: 'dshac-settingTitle' }, title), h('div', { className: 'dshac-settingDesc' }, desc)),
          control,
        );

      const switchRow = (key, title, desc) =>
        row(
          title,
          desc,
          h(
            'div',
            { className: 'dshac-settingControl' },
            h('button', {
              type: 'button',
              role: 'switch',
              'aria-checked': state.fields[key] ? 'true' : 'false',
              'aria-label': title,
              className: 'dshac-switch',
              'data-on': state.fields[key] ? '1' : '0',
              disabled,
              onClick: () => toggle(key)(!state.fields[key]),
            }, h('span', { className: 'dshac-knob' })),
          ),
          false,
        );

      return h(
        'div',
        { className: 'dshac-settings' },
        h('style', { key: 'style' }, CSS),
        h('h3', { className: 'dshac-settingsTitle' }, t('settings.title')),
        h('p', { className: 'dshac-settingsLead' }, t('settings.lead')),
        state.ready
          ? h(
              React.Fragment,
              null,
              switchRow('showInMore', t('settings.showInMore'), t('settings.showInMore.desc')),
              switchRow('showInComposer', t('settings.showInComposer'), t('settings.showInComposer.desc')),
              row(
                t('settings.port'),
                t('settings.port.desc'),
                h(
                  'div',
                  { className: 'dshac-settingControl' },
                  h('input', {
                    className: 'dshac-field',
                    'data-narrow': '1',
                    inputMode: 'numeric',
                    value: state.fields.port,
                    placeholder: String(state.resolved.port || 7788),
                    disabled,
                    onChange: (event) => setState((prev) => ({ ...prev, fields: { ...prev.fields, port: event.target.value } })),
                    onBlur: commitPort,
                    onKeyDown: (event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        event.currentTarget.blur();
                      }
                    },
                  }),
                ),
                false,
              ),
              row(
                t('settings.root'),
                t('settings.root.desc'),
                h('input', {
                  className: 'dshac-field',
                  'data-wide': '1',
                  value: state.fields.root,
                  placeholder: state.resolved.root,
                  disabled,
                  onChange: (event) => setState((prev) => ({ ...prev, fields: { ...prev.fields, root: event.target.value } })),
                  onBlur: commitRoot,
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      event.currentTarget.blur();
                    }
                  },
                }),
                true,
              ),
              // 数据目录：索引 / 日报 / 引用导出 / 关联表，默认 ~/.agentcenter
              row(
                t('settings.dataDir'),
                t('settings.dataDir.desc'),
                h('input', {
                  className: 'dshac-field',
                  'data-wide': '1',
                  value: state.fields.dataDir,
                  placeholder: state.resolved.dataDir,
                  disabled,
                  onChange: (event) => setState((prev) => ({ ...prev, fields: { ...prev.fields, dataDir: event.target.value } })),
                  onBlur: commitDataDir,
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      event.currentTarget.blur();
                    }
                  },
                }),
                true,
              ),
              h(
                'div',
                { className: 'dshac-settingsFoot' },
                h('span', null, h('b', null, t('settings.service')), ' · ', state.service || '—'),
                h('span', null, h('b', null, t('settings.resolved')), ' · ', state.resolved.root || '—'),
                h('span', null, h('b', null, t('settings.dataResolved')), ' · ', state.resolved.dataDir || '—'),
                state.busy !== '' && h('span', { className: 'dshac-settingsOk' }, `${state.busy} …`),
                state.note !== '' && h('span', { className: 'dshac-settingsOk' }, state.note),
                state.error !== '' && h('span', { className: 'dshac-settingsError' }, state.error),
                state.savable === false && h('span', { className: 'dshac-settingsError' }, t('settings.unavailable')),
              ),
            )
          : h('p', { className: 'dshac-settingsLead' }, t('state.checking')),

        // ---- AI 日报：模型（沿用 DSH 已配置的 provider/key）+ 生成格式 ----
        state.ready &&
          h(
            React.Fragment,
            null,
            h('h3', { className: 'dshac-settingsTitle', style: { marginTop: '18px' } }, t('settings.aiTitle')),
            h('p', { className: 'dshac-settingsLead' }, t('settings.aiLead')),
            row(
              t('settings.reportModel'),
              state.models.length === 0 ? t('settings.modelsEmpty') : t('settings.reportModel.desc'),
              h(
                'div',
                { className: 'dshac-settingControl' },
                h(
                  'select',
                  {
                    className: 'dshac-field',
                    'data-select': '1',
                    value: state.fields.reportModel,
                    disabled,
                    onChange: (event) => {
                      const next = event.target.value;
                      setState((prev) => ({ ...prev, fields: { ...prev.fields, reportModel: next } }));
                      void save({ reportModel: next }, t('settings.reportModel'));
                    },
                  },
                  h('option', { value: '' }, t('settings.reportModel.none')),
                  state.models.map((model) =>
                    h('option', { key: model.key, value: model.key }, `${model.providerName} · ${model.name}`),
                  ),
                ),
              ),
              false,
            ),
            row(
              t('settings.reportFormat'),
              t('settings.reportFormat.desc'),
              h(
                'div',
                { className: 'dshac-formatBox' },
                h('textarea', {
                  className: 'dshac-field dshac-textarea',
                  rows: 8,
                  value: state.fields.reportFormat,
                  placeholder: state.defaultFormat,
                  disabled,
                  onChange: (event) => setState((prev) => ({ ...prev, fields: { ...prev.fields, reportFormat: event.target.value } })),
                }),
                h(
                  'div',
                  { className: 'dshac-formatActions' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dshac-ghost',
                      disabled,
                      onClick: () => setState((prev) => ({ ...prev, fields: { ...prev.fields, reportFormat: state.defaultFormat } })),
                    },
                    t('settings.reportFormat.reset'),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dshac-primary',
                      style: { height: '28px', padding: '0 12px', fontSize: '12.5px' },
                      disabled,
                      onClick: () => save({ reportFormat: state.fields.reportFormat }, t('settings.reportFormat')),
                    },
                    t('settings.reportFormat.save'),
                  ),
                ),
              ),
              true,
            ),
          ),
      );
    }

    /** Composer control: opens the previous-session picker. */
    function ComposerReferenceButton(props) {
      const t = translator(props);
      const openPicker = props.openPicker;
      return h(
        React.Fragment,
        null,
        h('style', { key: 'style' }, CSS),
        h(
          'button',
          {
            key: 'button',
            type: 'button',
            className: 'dshac-tool',
            title: t('composer.open'),
            'aria-label': t('composer.open'),
            onClick: () => openPicker(props.sessionId),
          },
          h(
            'svg',
            {
              viewBox: '0 0 24 24',
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: 1.8,
              strokeLinecap: 'round',
              strokeLinejoin: 'round',
              'aria-hidden': 'true',
            },
            h('path', { d: 'M4 6h16M4 12h10M4 18h7' }),
            h('path', { d: 'M17.5 13.5v6M14.5 16.5h6' }),
          ),
        ),
      );
    }

    /** The picker sheet, rendered into the frame-wide overlay slot. */
    function SessionPickerOverlay(props) {
      const t = translator(props);
      const store = props.store;
      const state = useStore(store);
      const inputRef = useRef(null);

      useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            props.close();
          }
        };
        document.addEventListener('keydown', onKey, true);
        return () => document.removeEventListener('keydown', onKey, true);
      }, [props]);

      useEffect(() => {
        store.search('');
        if (inputRef.current) inputRef.current.focus();
      }, [store]);

      const insert = () => {
        const done = props.insert();
        if (done) props.close();
      };

      if (!state.open) return null;
      return h(
        'div',
        { className: 'dshac-scrim', onMouseDown: (event) => event.target === event.currentTarget && props.close() },
        h('style', { key: 'style' }, CSS),
        h(
          'div',
          { className: 'dshac-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('composer.title') },
          h(
            'div',
            { className: 'dshac-sheetHead' },
            h('div', { className: 'dshac-sheetTitle' }, t('composer.title')),
            h('div', { className: 'dshac-sheetHint' }, t('composer.hint')),
          ),
          h(
            'div',
            { className: 'dshac-search' },
            h(
              'select',
              {
                className: 'dshac-field',
                'data-select': '1',
                value: state.agentFilter,
                onChange: (event) => store.setAgent(event.target.value),
                'aria-label': t('composer.filterAgent'),
              },
              h('option', { value: '' }, t('composer.allAgents')),
              (state.agents || []).map((row) =>
                h('option', { value: row.id, key: row.id }, `${row.name}（${row.count}）`),
              ),
            ),
            h('input', {
              ref: inputRef,
              className: 'dshac-input',
              placeholder: t('composer.search'),
              value: state.query,
              onChange: (event) => store.set({ query: event.target.value }),
              onKeyDown: (event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  store.search(state.query);
                }
              },
            }),
            h('button', { type: 'button', className: 'dshac-ghost', onClick: () => store.search(state.query) }, t('action.refresh')),
          ),
          h(
            'div',
            { className: 'dshac-list' },
            state.loading && h('div', { className: 'dshac-hint', style: { padding: '10px' } }, h('span', { className: 'dshac-spinner' })),
            !state.loading && state.items.length === 0 && h('div', { className: 'dshac-hint', style: { padding: '10px' } }, t('composer.empty')),
            state.items.map((item) =>
              h(
                'button',
                {
                  key: item.id,
                  type: 'button',
                  className: 'dshac-row',
                  'data-active': state.selected === item.id ? '1' : '0',
                  onClick: () => store.pick(item),
                },
                h('span', { className: 'dshac-rowTitle' }, item.title || item.id),
                h(
                  'span',
                  { className: 'dshac-rowMeta' },
                  h('span', null, item.agentName || item.agentId || ''),
                  h('span', null, item.project || ''),
                  h('span', null, item.end || item.startedAt || ''),
                  h('span', null, `${item.messages ?? 0} 条消息`),
                ),
              ),
            ),
          ),
          h(
            'div',
            { className: 'dshac-foot' },
            h(
              'span',
              { className: 'dshac-footInfo' },
              state.error ? state.error : state.picked ? `${t('composer.ready')} · ${state.chars} 字` : state.needSession ? t('composer.needSession') : '',
            ),
            h('button', { type: 'button', className: 'dshac-ghost', onClick: props.close }, t('composer.cancel')),
            h(
              'button',
              { type: 'button', className: 'dshac-primary', disabled: !state.picked || state.loading, onClick: insert },
              t('composer.insert'),
            ),
          ),
        ),
      );
    }

    /**
     * @param ctx - Client context with slots, locale, and the optional workspace,
     *   session, and conversation services.
     * @param config - Host-provided config (`showInMore`) resolved at activation.
     */
    function applyWith(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'agentcenter: locale');
      const t = ctx.locale.bind(NS);

      const bridge = { frame: null, links: null, workspaces: null };
      const picker = createStore({
        open: false,
        sessionId: '',
        query: '',
        agentFilter: '',
        agents: [],
        items: [],
        loading: false,
        error: '',
        picked: null,
        text: '',
        chars: 0,
        needSession: false,
      });

      // ---- frame <-> page protocol -------------------------------------------------
      const reply = (requestId, ok, data, error) => {
        const frameApi = bridge.frame;
        const win = frameApi && frameApi.current ? frameApi.current.contentWindow : null;
        if (!win) return;
        win.postMessage({ source: 'dsh-agentcenter', type: 'response', requestId, ok, data: data ?? null, error: error ?? null }, '*');
      };

      /** 宿主主动推给页面的通知（例如定时扫描完成）。 */
      const notify = (event, payload) => {
        const frameApi = bridge.frame;
        const win = frameApi && frameApi.current ? frameApi.current.contentWindow : null;
        if (!win) return;
        win.postMessage({ source: 'dsh-agentcenter', type: 'event', event, ...(payload || {}) }, '*');
      };
      bridge.notify = notify;

      const openSession = (sessionId) => {
        const workspace = ctx.get('uiWorkspace');
        if (workspace === undefined || typeof workspace.openSession !== 'function') throw new Error('uiWorkspace 不可用');
        workspace.openSession(sessionId);
      };

      /**
     * 把草稿填进一个**刚打开**的会话。
     *
     * `conversation.input.for(actx)` 要求「已 retain 的 scope」，新会话刚打开时常常还没到；
     * 而且它直接 setDraft 会被 UI 的 draft 初始化覆盖。这里改用官方的「新任务草稿初始化」入口
     * `input.requestDraftInitialization(binding, { prompt, whenDraftExists })`：
     * 等 binding 出现且 openState 为 open 再调用，语义与在工作区里新建任务完全一致。
     */
    const seedDraft = async (sessionId, text) => {
      const sessions = ctx.get('sessions');
      const conversation = ctx.get('conversation');
      if (sessions === undefined || conversation === undefined) return 'unavailable';
      const input = conversation.input;
      if (input === undefined || typeof input.requestDraftInitialization !== 'function') return 'unavailable';
      for (let attempt = 0; attempt < 80; attempt += 1) {
        try {
          const binding = typeof sessions.binding === 'function' ? sessions.binding(sessionId) : undefined;
          if (binding !== undefined) {
            const snapshot = binding.session && typeof binding.session.getSnapshot === 'function' ? binding.session.getSnapshot() : null;
            if (snapshot === null || snapshot.openState === 'open') {
              const outcome = input.requestDraftInitialization(binding, { prompt: text, whenDraftExists: 'keep' });
              if (outcome === 'applied' || outcome === 'preserved') return outcome;
            }
          }
        } catch {
          /* 还在打开中 */
        }
        await sleep(120);
      }
      // 兜底：至少把文本写进 draft（旧入口），失败就是真失败
      try {
        const scope = sessions.scope(sessionId);
        if (scope !== undefined && typeof input.for === 'function') {
          const target = input.for(scope);
          if (target !== undefined && typeof target.setDraft === 'function') {
            target.setDraft(text);
            return 'applied';
          }
        }
      } catch {
        /* 忽略 */
      }
      return 'failed';
    };

    /** 找到「路径等于这个目录」的工作区；没有就建一个（会话的 cwd 来自工作区）。 */
    const ensureWorkspace = async (cwd) => {
      const target = typeof cwd === 'string' ? cwd.trim() : '';
      const normalize = (value) => String(value ?? '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
      const snapshot = bridge.workspaces;
      if (target !== '' && snapshot !== null && Array.isArray(snapshot.items)) {
        const hit = snapshot.items.find((item) => normalize(item.path) === normalize(target));
        if (hit !== undefined) return hit.workspaceId;
      }
      const workspaces = ctx.get('workspaces');
      if (workspaces === undefined || typeof workspaces.create !== 'function') {
        throw new Error('workspaces 服务不可用，无法切换工作区');
      }
      if (target === '') throw new Error('这条历史任务没有记录工作目录');
      let view;
      try {
        view = await workspaces.create({ path: target });
      } catch (error) {
        throw new Error('创建工作区失败（' + target + '）：' + (error instanceof Error ? error.message : String(error)));
      }
      bridge.workspaces = null; // 下次渲染会重新取快照
      return view.workspaceId;
    };

      const continueConversation = async (taskId) => {
        const plan = await post('/api/agentcenter/continue', { taskId });
        if (!plan.ok || !plan.body || plan.body.ok !== true) {
          throw new Error(plan.body?.error || `HTTP ${plan.status}`);
        }
        const detail = plan.body;

        /** 会话里只放路径：导出文件 +（需要时）解析规则，正文由模型按需读取。 */
        const references = (info) => {
          const lines = [t('continue.intro')];
          if (typeof info.filePath === 'string' && info.filePath !== '') lines.push(`@${info.filePath}`);
          if (typeof info.rulePath === 'string' && info.rulePath !== '') {
            lines.push('', t('composer.ruleIntro'), `@${info.rulePath}`);
          }
          return lines.join('\n');
        };

        /** 新建会话：**先落到任务当时的工作区**，再打开它并初始化草稿。 */
        const createAndSeed = async (text) => {
          const workspace = ctx.get('uiWorkspace');
          if (workspace === undefined || typeof workspace.connectWorkspace !== 'function') {
            throw new Error('uiWorkspace 服务不可用');
          }
          const workspaceId = await ensureWorkspace(detail.cwd);
          // connectWorkspace 会复用该工作区里的空白会话、否则新建一个，并返回真实的 SessionId
          const created = await workspace.connectWorkspace(workspaceId);
          openSession(created);
          const seeded = text ? await seedDraft(created, text) : 'skipped';
          return { sessionId: created, seeded };
        };

        let action = 'opened';
        let sessionId = detail.sessionId;
        let seeded = 'skipped';
        if (detail.kind === 'dsh-session') {
          try {
            openSession(detail.sessionId);
          } catch {
            // 索引里的会话已经打不开了：导出成文件，新建一个会话接着聊。
            const made = await post('/api/agentcenter/materialize', { taskId, maxChars: 18000 });
            const created = await createAndSeed(references(made.body || {}));
            sessionId = created.sessionId;
            seeded = created.seeded;
            action = 'created';
          }
        } else {
          const created = await createAndSeed(references(detail));
          sessionId = created.sessionId;
          seeded = created.seeded;
          action = 'created';
        }
        const linked = await post('/api/agentcenter/link', { taskId, sessionId, action, title: detail.title, agentId: detail.agentId });
        bridge.links = linked.ok && linked.body && linked.body.links ? linked.body.links : null;
        return { action, sessionId, seeded, cwd: detail.cwd || '' };
      };

      const handleRequest = async (message) => {
        const { requestId, action, payload } = message;
        try {
          if (action === 'ping') {
            reply(requestId, true, { enabled: true });
            return;
          }
          if (action === 'links') {
            const result = bridge.links !== null ? { ok: true, body: { links: bridge.links } } : await call('/api/agentcenter/links', { method: 'GET' });
            bridge.links = result.body?.links ?? { version: 1, tasks: {} };
            reply(requestId, true, bridge.links);
            return;
          }
          if (action === 'continue') {
            const out = await continueConversation(payload?.taskId);
            reply(requestId, true, out);
            return;
          }
          if (action === 'open-session') {
            openSession(payload?.sessionId);
            reply(requestId, true, { opened: true });
            return;
          }
          if (action === 'ai-report') {
            // 页面的日报页点「AI 总结」：由 Host 用 DSH 已配置的模型生成
            const result = await post('/api/agentcenter/report/ai', { date: payload?.date });
            if (!result.ok || !result.body || result.body.ok !== true) {
              throw new Error(result.body?.error || `HTTP ${result.status}`);
            }
            reply(requestId, true, result.body);
            return;
          }
          if (action === 'save-report') {
            const result = await post('/api/agentcenter/report/save', {
              date: payload?.date,
              markdown: payload?.markdown,
              model: payload?.model,
            });
            if (!result.ok || !result.body || result.body.ok !== true) {
              throw new Error(result.body?.error || `HTTP ${result.status}`);
            }
            reply(requestId, true, result.body);
            return;
          }
          reply(requestId, false, null, 'unknown action: ' + String(action));
        } catch (failure) {
          reply(requestId, false, null, failure instanceof Error ? failure.message : String(failure));
        }
      };

      ctx.effect(() => {
        const onMessage = (event) => {
          const message = event.data;
          if (!message || message.source !== 'agentcenter-h5' || message.type !== 'request') return;
          const frameApi = bridge.frame;
          const win = frameApi && frameApi.current ? frameApi.current.contentWindow : null;
          if (win === null || event.source !== win) return;
          void handleRequest(message);
        };
        window.addEventListener('message', onMessage);
        return () => window.removeEventListener('message', onMessage);
      }, 'agentcenter: frame bridge');

      // ---- the page ---------------------------------------------------------------
      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: PANEL, locale: NS, inject: () => ({ bridge }) }, AgentCenterPage),
      );

      /* ---- entry placement, live ------------------------------------------------
         `showInMore` decides WHERE the entry sits, not whether it exists:
           true  → a row inside the panel list's More menu
           false → its own panel row, right above More
         A store keeps both placements (and the composer control) in sync with the
         settings page, so a save takes effect without waiting for a plugin restart;
         a focus refetch covers edits made outside this page. */
      const configStore = createStore({ showInMore: true, showInComposer: true, ready: false });
      const openPanel = () => {
        const layout = ctx.get('layout');
        if (layout === undefined || typeof layout.selectPanel !== 'function') {
          ctx.logger?.warn?.('agentcenter: the layout service is unavailable');
          return;
        }
        layout.selectPanel(PANEL);
      };
      const readConfig = () => {
        call('/api/agentcenter/config', { method: 'GET' })
          .then((result) => {
            const body = result.ok && result.body ? result.body : {};
            configStore.set({ showInMore: body.showInMore !== false, showInComposer: body.showInComposer !== false, ready: true });
          })
          .catch(() => configStore.set({ ready: true }));
      };
      readConfig();
      ctx.effect(() => {
        const onFocus = () => readConfig();
        window.addEventListener('focus', onFocus);
        return () => window.removeEventListener('focus', onFocus);
      }, 'agentcenter: config refetch on focus');

      /** Keep one list registration in sync with a predicate over the config. */
      const syncEntry = (shouldExist, register) => {
        let dispose = null;
        const sync = () => {
          const want = shouldExist(configStore.getSnapshot());
          if (want && dispose === null) dispose = register();
          else if (!want && dispose !== null) {
            dispose();
            dispose = null;
          }
        };
        const off = configStore.subscribe(sync);
        sync();
        return () => {
          off();
          if (dispose !== null) dispose();
        };
      };

      // ---- Settings → AgentCenter --------------------------------------------------
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'agentcenter',
            order: 30,
            label: () => t('settings.label'),
            locale: NS,
            inject: () => ({ applyConfig: (patch) => configStore.set(patch) }),
          },
          AgentCenterSettings,
        ),
      );

      // ---- entry: inside the More menu, or its own panel row ----------------------
      ctx.slots.inject('sidebar.panellist.actions', () =>
        syncEntry(
          (config) => config.showInMore === true,
          () =>
            ctx.slots.register(
              {
                name: 'sidebar.panellist.actions',
                id: 'agentcenter',
                order: 40,
                label: () => t('entry.label'),
                locale: NS,
                inject: () => ({ open: openPanel }),
              },
              MoreEntry,
            ),
        ),
      );
      ctx.slots.inject('sidebar.panellist', () =>
        syncEntry(
          (config) => config.showInMore === false,
          () =>
            ctx.slots.register(
              { name: 'sidebar.panellist', id: PANEL, order: 40, label: () => t('entry.label'), locale: NS },
              PanelEntry,
            ),
        ),
      );

      // ---- composer control + its overlay -----------------------------------------
      const closePicker = () => {
        picker.set({ open: false, picked: null, text: '', chars: 0, error: '', needSession: false });
      };
      const openPicker = (sessionId) => {
        if (typeof sessionId !== 'string' || sessionId === '') {
          picker.set({ open: true, needSession: true, sessionId: '', items: [], query: '', picked: null, text: '' });
        } else {
          picker.set({ open: true, needSession: false, sessionId, query: '', picked: null, text: '' });
        }
      };
      const insertPicked = () => {
        const state = picker.getSnapshot();
        if (!state.picked || state.text === '' || state.sessionId === '') return false;
        try {
          const sessions = ctx.get('sessions');
          const conversation = ctx.get('conversation');
          if (sessions === undefined || conversation === undefined) throw new Error('sessions/conversation 不可用');
          const scope = sessions.scope(state.sessionId);
          if (scope === undefined) throw new Error(t('composer.needSession'));
          const target = conversation.input.for(scope);
          const draft = target.state.getSnapshot().draft;
          const text = `${state.text}`;
          const next = draft.trim() === '' ? text : `${draft}${/\s$/.test(draft) ? '' : '\n\n'}${text}`;
          target.setDraft(next);
          return true;
        } catch (failure) {
          picker.set({ error: `${t('composer.failed')}：${failure instanceof Error ? failure.message : String(failure)}` });
          return false;
        }
      };

      ctx.effect(() => () => closePicker(), 'agentcenter: picker cleanup');

      // The sheet lives in the frame-wide overlay layer; it renders nothing while closed,
      // so one static registration covers every open (and follows the declaration lifetime).
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          {
            name: 'shell.overlay',
            id: PICKER_OVERLAY_ID,
            order: 90,
            locale: NS,
            inject: () => ({ store: picker, close: closePicker, insert: insertPicked }),
          },
          SessionPickerOverlay,
        ),
      );

      // ---- the composer control, gated by `showInComposer` -------------------------
      ctx.slots.inject('conversation.input.left', () =>
        syncEntry(
          (config) => config.showInComposer === true,
          () =>
            ctx.slots.register(
              {
                name: 'conversation.input.left',
                id: COMPOSER_ID,
                order: 61,
                label: () => t('composer.open'),
                locale: NS,
                inject: () => ({ openPicker }),
              },
              ComposerReferenceButton,
            ),
        ),
      );

      // Store actions used by the overlay component.
      picker.search = (query) => {
        picker.set({ loading: true, error: '' });
        const q = typeof query === 'string' ? query.trim() : '';
        const agent = picker.getSnapshot().agentFilter || '';
        const params = ['limit=200'];
        if (q !== '') params.push('q=' + encodeURIComponent(q));
        if (agent !== '') params.push('agent=' + encodeURIComponent(agent));
        call(`/api/agentcenter/sessions?${params.join('&')}`, { method: 'GET' })
          .then((result) => {
            const body = result.body || {};
            const items = Array.isArray(body.items) ? body.items : [];
            // 分面优先用宿主给的 `agents`；老版本宿主没这个字段时，从条目里自己聚合，
            // 保证下拉里一定有可选项（也就一定能筛到别的 Agent）。
            const counts = new Map();
            for (const item of items) {
              const id = String(item.agentId ?? '');
              const row = counts.get(id);
              if (row === undefined) counts.set(id, { id, name: String(item.agentName ?? '') || id, count: 1 });
              else row.count += 1;
            }
            const agents = Array.isArray(body.agents) && body.agents.length > 0 ? body.agents : [...counts.values()];
            // 老版本宿主按「DSH 优先」排序；这里再按开始时间倒序一次，保证列表是各 Agent 混排。
            const sorted = items.slice().sort((left, right) => millis(right.startedAt) - millis(left.startedAt));
            // 老版本宿主会忽略 ?agent=，这里自己再过一遍，保证筛选一定生效。
            const visible = agent === '' ? sorted : sorted.filter((item) => String(item.agentId ?? '') === agent);
            picker.set({ loading: false, items: visible, query: q, agents, error: result.ok ? '' : '读取 AgentCenter 索引失败' });
          })
          .catch((failure) => picker.set({ loading: false, items: [], error: String(failure.message ?? failure) }));
      };
      picker.setAgent = (agent) => {
        picker.set({ agentFilter: typeof agent === 'string' ? agent : '', picked: null, text: '' });
        picker.search('');
      };
      picker.pick = (item) => {
        picker.set({ picked: item, loading: true, error: '', text: '', chars: 0 });
        // 引用的不是原始会话文件（zstd / SQLite / IDE 库里模型读不了），而是导出的一份 Markdown；
        // 落到 data/引用/ 后把路径放进对话框，让模型自己按需读取。
        post('/api/agentcenter/materialize', { taskId: item.id, maxChars: 18000 })
          .then((result) => {
            if (!result.ok || !result.body || result.body.ok !== true) {
              picker.set({ loading: false, error: result.body?.error || `HTTP ${result.status}`, picked: null });
              return;
            }
            const reference = result.body;
            const lines = [t('composer.intro'), `@${reference.path}`];
            if (typeof reference.rulePath === 'string' && reference.rulePath !== '') {
              lines.push('', t('composer.ruleIntro'), `@${reference.rulePath}`);
            }
            picker.set({ loading: false, picked: item, text: lines.join('\n'), chars: reference.chars || 0, filePath: reference.path });
          })
          .catch((failure) => picker.set({ loading: false, picked: null, error: String(failure.message ?? failure) }));
      };

      const close = () => closePicker();
      const insert = () => insertPicked();
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        applyWith(ctx);
      },
    };
  },
});