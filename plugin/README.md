# dsh-agentcenter

**AgentCenter for DeepSeek Harness** — a read-only task center for every AI coding agent on your machine, living inside the DSH Web UI.

- **Panel page** — one entry in the left panel list opens the whole AgentCenter UI. DSH 0.2.2+ keeps unpinned panels in the sidebar's **更多** (More) menu with a pin control; the plugin only supplies the icon. If the local service is not running the page shows a single **启动服务** button; clicking it hosts the service **inside the DSH process** (no child process, no browser window) and swaps in the real page.
- **Task center** — 12 built-in adapters scan DeepSeek Harness, Claude Code, Codex CLI, CodeBuddy, WorkBuddy, Qoder, Trae, zCode, OpenCode, AtomCode, 豆包 and 千问 session stores; statuses, active time, disk usage, todos and full conversation replay.
- **Continue a session** — from a task's conversation, 「继续对话」 opens the original DSH session, or exports another agent's session to Markdown and starts a new DSH session **in that task's working directory** with the export referenced.
- **Reference a session** — a composer button lists every scanned session (filter by agent) and inserts the exported file path into the draft.
- **Scheduled scanning** — the 扫描调度 rules (interval / daily / weekly) are executed **inside the DSH host process**: every minute the plugin checks ~/.agentcenter/config.json and runs an incremental scan when due (plus the daily report only when reportAuto is explicitly enabled), then tells the open page to refresh. It stops with DSH; for unattended runs use the standalone daemon.
- **AI daily report** — in the report detail page, 「AI 总结这一天」 asks **your own DSH model** to rewrite that day; 「保存为今日日报」 stores it as a 「日报总结（AI）」 section **above** the deterministic report, never replacing it.

## Install

From npm, through the DSH Plugin Manager (**Settings → Plugins → Add plugin**) or by package name:

```
dsh-agentcenter
```

Requires **Node 22.15+ / 23.8+** for reading DeepSeek Harness .zstd sessions; on older Node the service still starts and every other agent scans — those sessions are reported as skipped with the reason.

The package is self-contained: the runtime it serves (`h5/` + `core/` + the parsing-rule docs) ships inside it under `app/`, so **no local checkout and no `root` setting are needed**.

Develop against a checkout instead? Add the plugin row that points at this directory:

```powershell
plugin_manager install_bundle target = <this directory>
```

## Where the data goes

Everything the plugin produces lives in a **user-level data directory** (not inside the installed package, so upgrades never wipe it):

| Path | Content |
|---|---|
| `~/.agentcenter/summary.json`、`index.json`、`scans.json`、`fingerprints.json` | scan output (rebuildable) |
| `~/.agentcenter/日报/<date>.md` | daily reports (AI section + deterministic section) |
| `~/.agentcenter/引用/<taskId>.md` | session exports referenced from conversations |
| `~/.agentcenter/links.json` | task → DSH session links |
| `~/.agentcenter/overrides.json`、`config.json` | manual “done” marks and scan configuration |

The directory can be changed in **Settings → AgentCenter → 数据目录** (`dataDir`). On first activation the plugin copies `links.json`、`overrides.json`、`config.json` and the reports from an older in-repo `data/` directory when one exists, then writes `.migrated` so it only does that once.

## Settings

No YAML editing. Everything lives in **DSH → Settings → AgentCenter** and is saved into the current profile's config layer through `ctx.configEditor`:

| Setting | Meaning | Default |
|---|---|---|
| 输入区显示「引用历史会话」 | the composer reference button | on |
| 本地服务端口 | port the panel's Start service listens on | `7788` |
| AgentCenter 目录 | advanced: point at a source checkout; empty uses the bundled `app/` | empty |
| 数据目录 | where the index/reports/exports/links live | `~/.agentcenter` |
| 日报模型 | model used by the AI report — picked from **your DSH provider list**, no API key stored here | not selected |
| 日报格式 | the Markdown skeleton the model fills; empty uses the built-in by-project template | empty |

Where the sidebar entry sits is no longer a plugin setting: DSH 0.2.2+ owns the sidebar's **更多** (More) menu, lists every unpinned panel there with a pin control, and keeps the choice in memory. The plugin only contributes its panel icon.

## Continue / reference a session

Both entry points hand the model a **file path**, never a wall of text:

- **Continue a session** (task detail → 「继续对话」): a DSH session opens directly. Any other agent's
  session is first exported to `<dataDir>/引用/<taskId>.md`, then the plugin **finds or creates the
  workspace for that task's own working directory**, creates a session in it
  (`uiWorkspace.connectWorkspace`), opens it, and seeds the composer with the export path plus the
  parsing-rules path via the official draft-initialization entry (`input.requestDraftInitialization`,
  so an existing draft is kept). The task detail then shows the link to that session.
- **Reference a session** (composer button): pick any scanned session (filter by agent), the same export
  is produced and its path is inserted into the current draft.

## How it talks to DSH

- **Host half** (`index.js`) registers 16 authenticated Fetch routes on the `/api` channel: service lifecycle, row config read/write, session index, transcript export, reference materialization, parsing-rule list, scan, report AI generation/saving, and the task→session link table. It uses `ctx.llm` for the AI report, so the model and key are whatever DSH already has configured.
- **Client half** (`client.js`) registers the panel page (`main`), the panel icon (`sidebar.panellist`), the composer button (`conversation.input.left`), the settings page (`settings.section`) and the session picker (`shell.overlay`) — all with `--dsw-*` theme tokens only, no Harness client package imports.
- The panel page embeds the AgentCenter UI in a frame and bridges it over `postMessage` (`ping | links | continue | open-session | scan | ai-report | save-report`), because the frame cannot reach DSH services itself.

## Verification

From the AgentCenter checkout:

```bat
node tools\plugin-check.mjs 7793   :: 75 项：路由、生命周期、设置、索引/回放/导出/规则/扫描/AI 日报
node tools\verify.mjs              :: 37 项：扫描内核 / CLI / MCP / HTTP
node tools\render-check.mjs        :: 27 项：H5 渲染与响应式
node tools\bundle-app.mjs --check   :: app/ 是否落后于仓库里的运行时
```

`plugin-check.mjs` needs no DSH: it loads `index.js` with a fake connection registry and a scratch data dir.

## Publishing

1. `repository` / `homepage` / `bugs` already point at `github.com/xbqn/AgentCenter`; bump the version before each release.
2. `node tools\bundle-app.mjs` to refresh `app/` from the checkout, then `npm publish` from this directory (the `prepack` hook does the refresh automatically when the checkout is present).
3. To appear in the DSH **Discover** tab, the package has to be listed in the community catalog (`dsh-plugin-catalog`); that is a PR to the awesome-dsh-plugin index, not something the package can do itself. Until then, install by package name from **Settings → Plugins → Add plugin**.

## License

MIT — see [LICENSE](./LICENSE).