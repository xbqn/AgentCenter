# AgentCenter · DeepSeek Harness 插件

[![dsh plugin](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4F46E5)](https://github.com/deepseek-ai/DeepSeek-Harness)
[![npm](https://img.shields.io/npm/v/dsh-agentcenter?label=npm&color=cb3837)](https://www.npmjs.com/package/dsh-agentcenter)
[![license](https://img.shields.io/badge/license-MIT-green)](./plugin/LICENSE)

**同时用好几个 AI 编程工具的人，大概都遇到过同一件事**：上周那个方案是在 WorkBuddy 里聊的，还是 Qoder？那个报错的结论在 Trae 的哪次会话里？三个工具各存各的、各搜各的，找一段旧对话要挨个打开翻，翻到之后还得把上下文重新贴一遍才能接着问。

**AgentCenter 就是为这种"多工具并行工作"的场景做的**：把本机所有 Agent 的历史会话收拢到一个地方检索、回放，并**一键归到 DeepSeek Harness 里继续对话**。

它由两部分组成：

1. **`dsh-agentcenter`** —— 一个 [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness)（DSH）插件，可发布到 npm、通过 DSH 的插件管理器安装；
2. 插件所依赖的 **AgentCenter 扫描内核与 H5 界面**（同一份代码也支持独立运行）。

> 本仓库为公开代码镜像：只包含代码、文档与使用说明。不含任何本机路径、账号标识或真实会话数据。

---

## 为什么需要它

**谁用**：同时在 WorkBuddy、Qoder、Trae、CodeBuddy、Claude Code、Codex 等工具之间来回切换的开发者——比如用 A 工具做架构讨论、B 工具改代码、C 工具排查线上问题。

**痛点**：每个工具都有自己的一套会话存储（JSONL / SQLite / 内嵌库 / zstd 压缩），互不相通。想找"上次那个方案"只能凭记忆挨个工具翻；找到了也只是一个孤立的会话，想接着问就得把上下文复制出来重新贴。

**AgentCenter 的做法**：

| 你想做的事 | AgentCenter 怎么做 |
|---|---|
| 「这段话我在哪个工具里说过？」 | 一次扫描收拢 **12 个 Agent** 的会话，按标题/项目/**会话正文/模型思考**检索，命中直接给片段 |
| 「那次任务到底做完没有？」 | 每个会话判成 完成 / 进行中 / 中断 / 等待确认，并给出判定依据与活跃时长 |
| 「接着上次那件事继续」 | **继续对话**：其它 Agent 的会话导出成 Markdown，按原任务的工作目录在 DSH 里建会话，引用文件自动放进草稿 |
| 「写代码时想引用另一段历史」 | 输入框左侧按钮，选中任意历史会话，把引用文件插入当前草稿 |
| 「今天到底干了什么」 | 确定性日报（扫描事实）+ **AI 总结**（用你自己在 DSH 配置的模型） |

一句话：**跨工具检索历史 → 在 DSH 里统一继续**。会话内容全程留在本机，只读扫描，不改任何源文件。

## 这个插件做什么

统一采集本机各 AI Agent 工具的会话记录（只读扫描），回答三个问题——**这段时间 Agent 干了什么、哪些干完了哪些中断了、一共占了多少本地空间**——并把这些能力接进 DSH：

| 能力 | 说明 |
|---|---|
| **面板页面** | 左侧「更多」里一行 `AgentCenter`，点开就是完整任务中心；服务未启动时只有一个「启动服务」按钮，点击后在 **DSH 进程内**托管服务（不拉子进程、不开浏览器窗口） |
| **任务中心** | 12 个内置适配器扫描 DSH、Claude Code、Codex CLI、CodeBuddy、WorkBuddy、Qoder、Trae、zCode、OpenCode、AtomCode、豆包、千问；状态、活跃时长、空间占用、待办、完整对话回放 |
| **会话内容搜索** | 任务页可按「标题/项目」「会话内容」「含模型思考」三种范围搜索，命中给出角色 + 时间 + 片段 |
| **继续对话** | 从任务详情一键继续：DSH 会话直接打开；其它 Agent 的会话导出为 Markdown，**按该任务的工作目录**建会话并把引用文件放进草稿 |
| **引用历史会话** | 输入框左侧按钮：列出所有扫描到的会话，选中后把导出文件路径插入草稿 |
| **AI 日报** | 日报详情页「AI 总结这一天」用**你自己在 DSH 里配置的模型**重写当天；「保存为今日日报」写成 `## 日报总结（AI）` 章节，**不覆盖**下方确定性日报 |
| **定时扫描** | 「扫描调度」的间隔 / 每日 / 每周规则由插件在 DSH 进程内执行，到点增量扫描并通知面板刷新 |
| **设置页** | 全部设置都在 **DSH → 设置 → AgentCenter**，保存写入当前 profile 配置层，不需要手写 YAML |

## 支持的 Agent

| Agent | 会话存储形态 | 正文可读 |
|---|---|---|
| DeepSeek Harness | 多帧追加 zstd 压缩的 JSONL | ✅ |
| WorkBuddy | JSONL | ✅ |
| Qoder | JSONL（按项目 slug 目录分片，格式与 Claude Code 同源） | ✅ |
| CodeBuddy | VS Code 同构的 `state.vscdb`（SQLite） | ✅ |
| Claude Code / Codex CLI / zCode | 纯 JSONL（`claude-jsonl` 家族） | ✅ |
| AtomCode | `<hash>/<uuid>.jsonl`（user/assistant/tools 混排） | ✅ |
| OpenCode | SQLite | ✅ |
| Trae | `state.vscdb`（SQLite）里的会话元信息 | ⚠️ 只读元信息，正文在 IDE 内部存储 |
| 豆包工作台 / 千问工作台 | Electron 目录（LevelDB / Partitions / blob_storage） | ⚠️ 只统计目录占用 |

各工具格式、目录、编码都不同（zstd 压缩、SQLite 内嵌库、LevelDB、JSONL 混排），这也是"统一检索"必须靠一层适配器的原因：**12 份解析规则**写在 [`docs/解析规则/`](./docs/解析规则/)，每个 Agent 一份，可对照源码核对。表中标 ⚠️ 的两个只做元信息/占用统计，**不会**被当成正文检索到——避免让你误以为搜过它们的对话。

## 安装

包已发布到 npm：[`dsh-agentcenter`](https://www.npmjs.com/package/dsh-agentcenter)

```
npm view dsh-agentcenter version
```

### 方式一：在 DeepSeek Harness 里装（推荐）

1. 打开 DSH，进入 **设置 → 插件**；
2. 点 **添加插件**，在输入框里填包名：

   ```
   dsh-agentcenter
   ```

3. 确认安装，等待安装完成（首次会拉取约 170 KB 的包）；
4. 插件默认启用。回到主界面，左侧栏会多出 **AgentCenter** 入口；
5. 点开它，页面显示「启动服务」按钮时点一下——服务会在 **DSH 进程内**启动（不拉子进程、不开浏览器窗口），随后就是完整任务中心；
6. 想放到「更多」菜单里，或调整端口、数据目录、AI 日报模型：**设置 → AgentCenter**。

> 装完如果左侧没看到入口：确认插件处于启用状态，然后重载一次插件或按 `Ctrl+R` 刷新界面。

### 方式二：命令行安装

在 DSH 的 profile 目录下用插件管理器安装（`include:agentcenter` 是插件 id）：

```
dsh plugin add dsh-agentcenter
```

或者直接把包名写进 profile 的插件列表后重载。

### 方式三：从源码开发

```bat
git clone https://github.com/xbqn/AgentCenter.git
cd AgentCenter
node tools\bundle-app.mjs
```

然后用 DSH 的插件管理器以 **本地目录** 方式安装 `plugin/` 目录（指向 `plugin` 这个文件夹，不要指向整个仓库）。

改完 `h5/`、`core/` 或 `docs/解析规则/` 之后要重新跑 `node tools\bundle-app.mjs`，把运行时同步进 `plugin/app/`——插件实际服务的是那份副本。`node tools\bundle-app.mjs --check` 可以检查是否忘了同步。

### 环境要求

Node.js **22.15+ 或 23.8+**（读取 DSH 的多帧 `.zstd` 会话需要 `node:zlib` 的 zstd）。
更早的版本也能启动：其它 Agent 照常扫描，只有 DSH 的 `.zstd` 会话被跳过并在页面上说明原因。

### 装好之后先做这一步

打开 AgentCenter 页面 → 点「立即扫描」。首次扫描会遍历各 Agent 的会话目录（本机 500 多个会话大约十几秒到一分钟）。扫描完，任务列表、日报、空间统计才有数据。

## 独立运行（不装 DSH）

```bat
node cli\agentcenter.mjs scan     :: 只读扫描，写入 data\
h5\start-h5.cmd                    :: 启动 127.0.0.1:7788 并打开窗口
```

也可以只评审界面：双击 `h5/index.html`（未连服务时显示演示数据）。

## 数据放在哪里

插件模式下数据落在**用户目录**，不写进安装目录（升级不丢）：

| 路径 | 内容 |
|---|---|
| `~/.agentcenter/summary.json`、`index.json`、`scans.json`、`fingerprints.json` | 扫描索引（可重建） |
| `~/.agentcenter/日报/<date>.md` | 日报（AI 段 + 确定性段） |
| `~/.agentcenter/引用/<taskId>.md` | 供对话引用的会话导出 |
| `~/.agentcenter/search/` | 会话正文分片索引（深搜用，可删，删了下次重建） |
| `~/.agentcenter/links.json`、`overrides.json`、`config.json` | 任务↔会话关联、人工完成标记、扫描配置 |

独立运行时默认用仓库内的 `data/`，可用 `AC_DATA_DIR` 覆盖。

## 典型使用流程

假设你上午在 **WorkBuddy** 里讨论了一个改造方案，下午在 **Trae** 里改代码，晚上想接着上午的方案继续：

1. 打开 DSH 左侧「更多 → AgentCenter」，任务页搜「改造」——范围选**会话内容**，直接命中上午那段对话（带片段，能看出是哪个 Agent、几点说的）；
2. 点进任务详情，看当时的完整对话回放（用户 / 助手 / 思考 / 工具调用 / 结果都在）；
3. 点 **继续对话**——插件把那段会话导出成 Markdown，按当时的工作目录在 DSH 里新建会话，引用文件已经放进草稿；
4. 在这个 DSH 会话里接着问，模型能直接读到那份导出文件。

同样的入口也支持「写代码时引用另一段历史」：输入框左侧的按钮 → 选任意历史会话 → 引用文件插入草稿。

## 仓库结构

| 目录 | 性质 | 说明 |
|---|---|---|
| `core/` | 运行时 | 适配器、解析、回放、日报、扫描、调度、深搜索引 |
| `h5/` | 运行时 | 单文件 H5 界面 + 零依赖本地服务 |
| `plugin/` | 运行时（npm 包） | DSH 插件本体；`plugin/app/` 是打包用的运行时副本（`tools/bundle-app.mjs` 同步） |
| `cli/`、`mcp/` | 运行时（仅独立版） | 命令行与只读 MCP Server（不随 npm 包发布） |
| `docs/` | 说明 | 需求规格、展示形态、适配器规格、12 份解析规则、界面截图 |
| `tools/` | 开发 | 验收脚本（`verify` / `render-check` / `plugin-check`）与打包同步 |
| `prototype/` | 说明 | Obsidian 主视图原型，浏览器直接打开即可评审 |
| `data/` | 生成物 | 仅保留说明文件，实际产物不入库 |

## 验收

```bat
node tools\verify.mjs            :: 37 项：接口契约、CLI、MCP、只读保证
node tools\render-check.mjs      :: 27 项：Edge headless 渲染、响应式、持久化、降级
node tools\plugin-check.mjs      :: 75 项：DSH 插件路由、生命周期、设置、深搜、AI 日报
node tools\bundle-app.mjs --check :: plugin/app/ 是否落后于仓库运行时
```

## 设计取舍

1. **只读不写**：绝不修改、移动、删除任何 Agent 的原始会话文件。
2. **本地解析**：会话内容不出本机；AI 日报只在你主动点击时调用你自己配置的模型。
3. **一处内核，多种形态**：插件、H5、CLI、MCP 共用同一扫描内核，结果一致。
4. **插件不自带后台进程**：服务与调度都活在 DSH 进程内，DSH 退出即释放；需要无人值守时另跑 CLI 守护进程。
5. **页面用 iframe 承载**：AgentCenter 是独立的一套 H5，重写成 React 等于维护两套 UI；代价是 iframe 内不跟随 DSH 主题。
6. **"继续对话"不搬运整段正文**：只把**导出文件路径**放进草稿，让模型按需读取——几百轮的长会话直接塞进输入框会挤掉当前上下文。

## License

MIT，见 [plugin/LICENSE](./plugin/LICENSE)。
