# 解析规则索引 · AgentCenter 支持的全部 Agent

本目录为 `core/adapters.mjs` 的 **12 个内置适配器**各准备一份**自包含**的解析规则文档，供编码 agent 在 DSH 对话里被“投喂”后直接读懂原始会话文件。每份文档只依赖原始文件与本文，不要求先读仓库代码。

> 计数：`ADAPTERS` 数组共 **12** 条（`codebuddy`、`trae`、`qoder`、`workbuddy`、`zcode`、`opencode`、`atomcode`、`deepseek`、`codex`、`claudecode`、`doubao`、`qwen`）。`core/adapters.mjs` 顶部注释与 README 快速开始仍写“11 个”，是旧文案；以数组实际条数为准。

## 索引

| agentId | 显示名 | 存储形态 | 文件 |
|---|---|---|---|
| `codebuddy` | CodeBuddy | SQLite（`vscdb`） | [codebuddy.md](./codebuddy.md) |
| `trae` | Trae | SQLite（`vscdb`） | [trae.md](./trae.md) |
| `qoder` | Qoder | JSONL（`qoder`） | [qoder.md](./qoder.md) |
| `workbuddy` | WorkBuddy | JSONL（`workbuddy`） | [workbuddy.md](./workbuddy.md) |
| `zcode` | zcode | JSONL（`claude-jsonl`） | [zcode.md](./zcode.md) |
| `opencode` | OpenCode | SQLite（`opencode-db`） | [opencode.md](./opencode.md) |
| `atomcode` | AtomCode | JSONL（`atomcode`） | [atomcode.md](./atomcode.md) |
| `deepseek` | DeepSeek Harness | zstd JSONL（`dsh`） | [deepseek.md](./deepseek.md) |
| `codex` | Codex CLI | JSONL（`claude-jsonl`） | [codex.md](./codex.md) |
| `claudecode` | Claude Code | JSONL（`claude-jsonl`） | [claudecode.md](./claudecode.md) |
| `doubao` | 豆包工作台 | Electron 存储（`electron`） | [doubao.md](./doubao.md) |
| `qwen` | 千问工作台 | Electron 存储（`electron`） | [qwen.md](./qwen.md) |

表中的“存储形态”取适配器的 `kind`，括号内是解析家族 `family`；两者决定读法，不是展示文案。

## 怎么用这些文件

1. **在 DSH 对话里按路径引用**。直接把某个原始会话文件的路径发给 agent，并附上对应 `agentId` 的文档内容（或让它先读本目录的这份 `.md`），例如：

   ```
   ~/.claude/projects/<路径slug>/<sessionId>.jsonl
   ~/.dsh/sessions/<项目slug>/session-<uuid>/session.vN.jsonl.zstd
   %APPDATA%\Trae\User\globalStorage\state.vscdb
   ```

   路径里的 `~` / `%APPDATA%` / `%LOCALAPPDATA%` 由 agent 按当前平台展开；文档的“存储位置”一节已给出三平台默认路径与命名规则。

2. **同一份内容在插件里也能取到**，不必手工找文件：
   - 任务详情 → 对话回放（`/api/conversation?taskId=<id>`，只读原始会话文件，产出 `{role,time,text,tool}` 事件）；
   - 输入区「引用历史会话」→ 把该任务的 Markdown 回放（`/api/agentcenter/transcript`）插入当前草稿；
   - CLI `node cli/agentcenter.mjs conversation --taskId <id>`；
   - MCP 工具 `agentcenter_get_conversation`。

   因此“手上的路径”与“插件里的回放”是同一份数据的两种读法；文档描述的是**如何自己读原始文件**，插件路径用于快速核对。

## 共同约定（各文档都会重申）

- **只读**：任何情况下都不修改、不移动、不删除 Agent 源目录里的文件；SQLite 一律只读打开。
- **事件形状**：目标统一为 `{role, time, text, tool}`；`role` 取 `user` / `assistant` / `think` / `tool` / `result` / `todo`，`tool` 为工具名或 `null`。
- **状态**：`judgeStatus` 依据“心跳 / 文件 mtime 2 分钟 / 工具失败且无助手收尾 / 末尾用户消息 / 末尾提问 / 24 小时 / 空会话”，产出 `completed` / `running` / `interrupted` / `waiting` / `pending`；`vscdb` 与 `electron` 家族不走这套规则，各文档已单列。
- **任务切分**：同一会话内用户消息间隔 > 30 分钟切成多个任务；活跃时长剔除相邻消息 > 5 分钟的空隙。
- **容错**：坏 JSON 行计数跳过，坏行超过一半才判整会话失败；读取上限 6000 行（实现取文件前 6000 行，与注释“取尾部”不一致，文档已标出）。

## 待核实清单（代码未定论，各文档内已标注）

- `deepseek`：`data.source.kind` 除 `plugin` 外的取值；BOM 处理。
- `claudecode` / `qoder` / `zcode` / `codex` / `workbuddy` / `atomcode`：单会话 6000 行上限实际取“前 6000 行”与注释“取尾部”不符的设计意图。
- `claudecode`：`parentUuid` 分支重建未实现；`qoder`：`isSidechain` 未过滤。
- `codex`：`history.jsonl` 记录结构；`session_meta.payload.cwd` 未被读取。
- `zcode`：真实行格式未实测（本机未安装，无样本）。
- `atomcode`：`~/.atomcode/history.json` 未被解析。
- `codebuddy`：规格记载的 CLI 侧 `~/.codebuddy/projects` JSONL 未收录进适配器表。
- `doubao` / `qwen`：Electron LevelDB 会话读取未实现，是否存在可还原的会话正文未验证。