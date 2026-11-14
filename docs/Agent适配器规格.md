# AgentCenter — Agent 适配器规格与默认路径清单

> 数据来源：本机（Windows 11，user `dev`）实测扫描 + 公开资料。所有路径中的 `~` 代表 `%USERPROFILE%`。
> 实测状态：`✅ 已安装` / `—` 表示本机未安装（路径为按该工具通用约定给出的默认值，需实机校准）。

---

## 0. 总览

| # | Agent | id | 存储形态 | 默认路径（本机实测） | 实测状态 |
|---|---|---|---|---|---|
| 1 | CodeBuddy（IDE / CLI） | `codebuddy` | JSONL + 目录树 | `~\.codebuddy\`（CLI 侧）、`%APPDATA%\CodeBuddy CN\`（IDE 侧） | ✅ |
| 2 | Trae | `trae` | SQLite/LevelDB（IDE 派生） | `%APPDATA%\Trae\User\globalStorage\`、`~\.trae\` | — |
| 3 | WorkBuddy | `workbuddy` | JSONL（按项目分目录） | `~\.workbuddy\projects\<slug>\<sessionId>.jsonl` | ✅ |
| 4 | zcode | `zcode` | JSONL | `~\.zcode\sessions\` | — |
| 5 | OpenCode | `opencode` | SQLite + 文件 | `~\.local\share\opencode\opencode.db` | ✅ |
| 6 | AtomCode | `atomcode` | JSONL + 旁路文件 | `~\.atomcode\sessions\<hash>\<uuid>.jsonl` | ✅ |
| 7 | DeepSeek 桌面版 | `deepseek` | Electron LevelDB / SQLite | `%APPDATA%\@deepseek-ai\dsh-desktop\` | ✅ |
| 8 | Codex (OpenAI CLI) | `codex` | JSONL | `~\.codex\sessions\` | — |
| 9 | Claude Code | `claudecode` | JSONL | `~\.claude\projects\<slug>\*.jsonl` | — |
| 10 | 豆包工作台 | `doubao` | Electron LevelDB / IndexedDB | `%APPDATA%\Bytedance\Doubao\` | 部分（仅见 JianyingPro） |
| 11 | 千问工作台 | `qwen` | Electron 目录 | `%APPDATA%\Tongyi\` | ✅（目录存在，内容为 logs） |
| 12 | **Qoder（阿里 Qoder CN）** | `qoder` | JSONL（按项目分目录） | `~\.qoder-cn\projects\<路径slug>\<sessionId>.jsonl` | ✅（16 项目目录 / 26 会话） |

---

## 1. CodeBuddy

| 项 | 值 |
|---|---|
| 默认路径（CLI） | `~\.codebuddy\` |
| 默认路径（IDE） | `%APPDATA%\CodeBuddy CN\User\globalStorage\` |
| 关键子路径 | `~\.codebuddy\projects\`（会话）、`~\.codebuddy\memery\`（记忆）、`~\.codebuddy\logs\` |
| 实测产物 | `memery\{userId}_memery.md`、`user-memery-state.json`；IDE 侧 `User\globalStorage` 下为 Chromium 存储 |
| 备注 | 与 WorkBuddy 同源（CodeBuddy 内核），**可复用同一套 JSONL 解析器**，仅路径前缀不同 |

## 2. Trae

| 项 | 值 |
|---|---|
| 默认路径 | `%APPDATA%\Trae\User\globalStorage\`（IDE 派生，含 `state.vscdb` / `workspaceStorage`） |
| 备选 | `%LOCALAPPDATA%\Trae\`、`~\.trae\` |
| 存储形态 | 会话历史多存于 `globalStorage\state.vscdb`（SQLite）中的 `ItemTable`，键名含 `recentWorkspaces` / `chat` / `conversation` |
| 解析要点 | 需读 SQLite `ItemTable(key, value)`，value 为 JSON 字符串；JSON 内含会话数组与消息数组 |
| 备注 | 与 VSCode 系同构，若 Trae 改版可通过「通用 SQLite-ItemTable 适配器」覆盖 |

## 3. WorkBuddy

| 项 | 值 |
|---|---|
| 默认路径 | `~\.workbuddy\projects\<项目路径slug>\<sessionId>.jsonl` |
| slug 规则 | 路径中 `:\` → `-`，例：`E:\Code\...` → `D-Users-dev-WorkBuddy-2026-10-21-10-50-09` |
| 实测 | 41 个项目目录；同目录还有 `*.file-rollback.ndjson`（回滚快照，可作为「中间文件」来源） |
| 辅助索引 | `~\.workbuddy\app\sessions.json`（会话↔工作目录映射）、`~\.workbuddy\sessions\<pid>.json`（进程心跳，含 `lastHeartbeat`/`startedAt`/`kind`） |
| 产物目录 | `~\.workbuddy\artifact-index\`、`~\.workbuddy\blobs\`、`~\.workbuddy\clipboard-images\`、`~\.workbuddy\file-history\`、`~\.workbuddy\changes-index\`、`~\.workbuddy\changes-detail\` |
| JSONL 行类型 | `session-meta`（含 `id`/`sessionId`/`timestamp`/`meta`）、`message`（含 `role`、`content[]`，content 元素类型 `input_text` / `text` / `tool_use` / `tool_result`） |

**实测样本（首行）**：
```json
{"type":"session-meta","id":"01a15c5d-eaf8-...","sessionId":"af5b5438-...","timestamp":1792551021304,"meta":{"codebuddy.ai/hostKind":"unopted"}}
```

## 4. zcode

| 项 | 值 |
|---|---|
| 默认路径 | `~\.zcode\sessions\`、备选 `%APPDATA%\zcode\` |
| 存储形态 | 推测与 CodeBuddy/AtomCode 同源（JSONL + 旁路 `.events`/`.index`），需实机校准 |
| 备注 | 未装机，解析器按「通用 JSONL + 可配字段映射」实现 |

## 5. OpenCode

| 项 | 值 |
|---|---|
| 默认路径 | `~\.local\share\opencode\`（数据）、`~\.config\opencode\`（配置） |
| 实测 | `opencode.db`（约 18 MB，SQLite，WAL 模式）、`storage\`（`migration`/`session_diff`）、`tool-output\`（工具原始输出缓存 → 中间文件来源）、`snapshot\`（文件快照）、`log\`、`repos\`、`shell\` |
| 解析要点 | 从 `opencode.db` 读 `session` / `message` / `part` 三表；`tool-output` 与 `snapshot` 计入「中间文件/可回收空间」 |

## 6. AtomCode

| 项 | 值 |
|---|---|
| 默认路径 | `~\.atomcode\sessions\<hash>\<uuid>.jsonl` |
| 实测 | 已确认存在 18 个以上 hash 目录；同目录伴随 `.events`、`.index`、`.lease`、`.rewind`、`.meta.lock` |
| 辅助 | `~\.atomcode\history.json`（全局提问历史，结构 `[{role:"User", content:{Text:...}}]`）、`~\.atomcode\file-history\`、`~\.atomcode\image-cache\`、`~\.atomcode\datalog\`、`~\.atomcode\staged\` |
| 解析要点 | 主文件 JSONL；`.index` 可用于加速（避免全量解析）；`file-history`/`image-cache` 计入中间文件 |

**实测样本（history.json 首元素）**：
```json
{"role":"User","content":{"Text":"检查start.bat文件 …"}}
```

## 7. DeepSeek 桌面版（dsh-desktop）

| 项 | 值 |
|---|---|
| 默认路径 | `%APPDATA%\@deepseek-ai\dsh-desktop\` |
| 实测子项 | `desktop\settings.json`、`blob_storage\`、`Local Storage\`、`Session Storage\`、`Partitions\`、`logs\`、`WebStorage\` |
| 解析要点 | Electron 应用：会话多在 `Local Storage`（LevelDB）或 `Partitions\` 下的站点存储；需按 Chromium LevelDB 读取，必要时降级为「只统计目录占用 + 抓取可读文本」 |
| 备注 | 与豆包/千问同属 Electron 家族，可用同一套「Electron 存储适配器」 |

## 8. Codex (OpenAI CLI)

| 项 | 值 |
|---|---|
| 默认路径 | `~\.codex\sessions\` |
| 备选 | `~\.codex\history.jsonl` |
| 解析要点 | JSONL 会话；需支持 `session_meta` / `response_item` / `event_msg` 等行类型 |

## 9. Claude Code

| 项 | 值 |
|---|---|
| 默认路径 | `~\.claude\projects\<路径slug>\<sessionId>.jsonl` |
| 备选 | `~\.claude\history.jsonl` |
| 解析要点 | 每行含 `type`（`user`/`assistant`/`summary`）、`message.content[]`（`text`/`tool_use`/`tool_result`）、`timestamp`、`cwd`、`sessionId`、`uuid`；`parentUuid` 用于重建分支 |
| 中间文件 | `~/.claude/file-history\`、`~/.claude/projects\<slug>\*.backup`、`~/.claude/todos\`（todo 列表为待办抽取的黄金来源） |

## 10. 豆包工作台

| 项 | 值 |
|---|---|
| 默认路径 | `%APPDATA%\Bytedance\Doubao\`；备选 `%APPDATA%\Doubao\`、`%LOCALAPPDATA%\Doubao\` |
| 解析要点 | Electron：主会话走 `Local Storage` / `IndexedDB`（`Partitions\`）；附件与缓存走 `blob_storage` |
| 实测 | 本机 `%APPDATA%\Bytedance` 下仅有 `JianyingPro`（剪映），豆包本体未装 |

## 11. 千问工作台

| 项 | 值 |
|---|---|
| 默认路径 | `%APPDATA%\Tongyi\`；备选 `%APPDATA%\Qwen\`、`%LOCALAPPDATA%\Tongyi\` |
| 实测 | 目录存在，当前仅 `logs\` 子目录 |
| 解析要点 | Electron：会话走 `Local Storage` / `Partitions`；日志目录可用于推断活跃时间 |

---

## 11.1 Qoder（阿里 Qoder CN）

| 项 | 值 |
|---|---|
| 默认路径 | `~\.qoder-cn\projects\<路径slug>\<sessionId>.jsonl` |
| 备选 | `~\.qoder\projects\`（国际版） |
| slug 规则 | 与 Claude Code 同源：路径中 `:\` 与 `\` 转 `-`，例 `E:\Code\vibeCoding\jimureport` → `E--Code-vibeCoding-jimureport` |
| 辅助目录 | `~\.qoder-cn\` 下的 `file-history\`、`shell-snapshots\`、`session-env\`、`logs\`、`tmp\`（计入中间文件） |
| 解析要点 | 行格式与 Claude Code 同构：`type=user/assistant`，`message.content[]` 含 `text`/`thinking`/`tool_use`/`tool_result`；`timestamp` 为 **ISO 字符串**；顶层带 `cwd`/`sessionId` |
| 关键坑 | ① **工具结果回传也放在 `type=user` 行里**（只有 `tool_result`、无正文），必须剔除，否则「首条用户消息」被淹没、任务标题退化成助手消息或「未命名任务」；② 自动续跑提示（`A goal has been set.`、`Continue working toward the active thread goal`）由 agent 自己生成，同样要过滤；③ 真实用户输入优先取 `humanInput.text` |
| 实测 | 16 个项目目录、26 个会话、51 个任务；最长会话 2978 个事件节点，对话可完整回放 |

**实测样本（首行）**：
```json
{"type":"workspace-directories","sessionId":"0f374157-...","directories":["D:\\Users\\<用户>\\Documents\\Qoder\\2026-10-22\\0f374157"]}
```

## 12. 通用自定义适配器（用户自建）

用户可在设置页添加任意 Agent，只需四项：

| 字段 | 说明 | 示例 |
|---|---|---|
| 名称 / 图标 | 展示用 | `MyAgent` / `🤖` |
| 根路径 | 会话根目录 | `D:\tools\myagent\` |
| 通配符 | 递归匹配规则 | `**/*.jsonl` |
| 解析方式 | JSONL / SQLite / 目录树 / Electron存储 | `jsonl` |
| 字段映射 | 时间/角色/内容/工具字段 | 时间 `timestamp`；角色 `role`；内容 `content`；工具 `tool_name` |

判定规则：
- 命中 JSONL 且字段映射齐全 → 走「通用 JSONL 适配器」，产出任务。
- 命中但字段缺失 → 进入「原始片段模式」：只登记文件与大小，UI 标注「未识别格式」。
- 路径不存在 → 置灰 + 「路径无效」提示，提供「重新探测」。

---

## 13. 存储占用统计口径

| 层级 | 统计内容 |
|---|---|
| Agent 级 | 该 Agent 根目录下所有文件的递归大小（排除符号链接，防环） |
| 会话级 | 会话文件本身 + 同名旁路文件（`.events`/`.index`/`.rewind` 等） |
| 任务级 | 会话文件按时间窗口切分后的估算值 + 关联 `file-history`/`tool-output`/`snapshot` 增量 |
| 中间文件 | 工具写文件但未进入交付清单的产物：`*_file-history/`、`tool-output/`、`snapshot/`、`*.file-rollback.ndjson`、`image-cache/`、`blobs/`、`clipboard-images/` |
| 可回收 | 中间文件总大小（**仅统计与展示，不自动删除**） |

---

## 14. 状态判定规则（可解释）

| 状态 | 判定条件 | `statusReason` 示例 |
|---|---|---|
| `completed` | 最后一条消息是助手终态回复，且无未完成 todo，且无 error 事件 | `助手正常收尾，共 23 次工具调用均成功` |
| `running` | 会话文件 `mtime` 在 2 分钟内，或存在活跃心跳进程（WorkBuddy `sessions\<pid>.json` 的 `lastHeartbeat` 新鲜） | `心跳 12 秒前更新` |
| `waiting` | 助手已回复但存在未决问题或等待用户输入 | `末尾提问等待用户确认` |
| `interrupted` | 出现 `error`/`abort`/`cancelled` 事件，或工具连续失败 | `工具 Bash 连续失败 3 次后中断` |
| `failed` | 会话以异常结束（`kind: failed`） | `任务异常终止` |
| `pending` | 从助手消息中抽出的待办未勾销 | `抽取到 3 项未完成待办` |

所有状态必须携带 `statusReason`，UI 展示判定依据，支持用户手动修正并回写为「人工覆盖」。
