# qoder · Qoder（阿里 Qoder CN）会话解析规则

> 适配器 id `qoder`｜显示名 Qoder｜存储形态 `JSONL`｜解析家族 `qoder`
> 依据：`core/adapters.mjs`（第 45–68 行注释与路径）、`core/parse.mjs`（`extractClaude`）、`core/util.mjs`、`docs/Agent适配器规格.md` §11.1

## 一句话用途

Qoder 是阿里推出的编码 IDE/Agent，会话格式与 Claude Code 同源。每个项目一个 slug 目录，每个会话一个 `.jsonl`：行是 `type=user/assistant` 的记录，正文在 `message.content[]`，思考块为 `thinking`，工具为 `tool_use` / `tool_result`。

## 存储位置

| 平台 | 默认路径 |
|---|---|
| Windows | `~\.qoder-cn\projects`、`~\.qoder\projects` |
| macOS | `~/.qoder-cn/projects`、`~/.qoder/projects` |
| Linux | `~/.qoder-cn/projects`、`~/.qoder/projects` |

- `~` 展开为 `%USERPROFILE%`（Windows）或 `$HOME`（macOS/Linux）；适配器根目录为 `~/.qoder-cn`。
- 首选国内版 `~/.qoder-cn/projects`，备选国际版 `~/.qoder/projects`；探测取第一个存在的路径。
- 布局：`~/.qoder-cn/projects/<路径slug>/<sessionId>.jsonl`；枚举递归遍历，取所有 `.jsonl` 文件，上限 4000。
- slug：项目路径中的 `:\` 与 `\` 变 `-`（`E:\Code\vibeCoding\demo` → `E--Code-vibeCoding-demo`）。
- 辅助目录（只统计）：`~/.qoder-cn/file-history`、`shell-snapshots`、`logs`、`tmp`、`session-env`。

## 文件格式

- 纯文本 JSONL，UTF-8；读时去 BOM、按 `\r?\n` 切分、跳空行，逐行 `JSON.parse`，坏行计数。
- 会话边界：**一个文件一个会话**；`sessionId` = 文件名去掉 `.jsonl`，`slug` = 上级目录名。
- 代表记录（字段名取自解析代码；首行常是 `workspace-directories`）：

```json
{"type":"workspace-directories","sessionId":"0f374157-...","directories":["D:\\work\\demo"]}
{"type":"user","sessionId":"0f374157-...","cwd":"D:\\work\\demo","timestamp":"2026-10-22T09:12:03.000Z","humanInput":{"text":"检查这段配置"},"message":{"content":[{"type":"text","text":"<system-reminder>…</system-reminder>\n检查这段配置"}]}}
{"type":"assistant","timestamp":"2026-10-22T09:12:07.000Z","message":{"content":[{"type":"thinking","thinking":"先读配置"},{"type":"text","text":"我来查。"},{"type":"tool_use","name":"Read","input":{"path":"config.yml"}}]}}
{"type":"user","timestamp":"2026-10-22T09:12:08.000Z","message":{"content":[{"type":"tool_result","is_error":false,"content":[{"type":"text","text":"…"}]}]}}
```

- 顶层字段另有 `isSidechain`（见 `core/adapters.mjs` 注释），解析代码未使用 → 见“坑”。

## 如何还原成对话

1. 逐行读（解析层最多 6000 行），坏行跳过；`type` 缺失的行按未知忽略。
2. `type === "user" || "assistant"`：取 `message.content`；字符串直接作正文，数组里 `text`→正文、`thinking`→思考（`thinking` 或 `text` 字段）、`tool_use`→工具调用（`name`/`input`）、`tool_result`→仅用 `is_error` 判断失败。
3. 用户行优先取 `humanInput.text`：Qoder 把注入上下文塞在 `message.content`，`humanInput.text` 才是用户真正输入；`humanInput.text` 去空白后非空则覆盖正文。
4. 用户行正文为空 → 整行丢弃（工具结果回传与注入上下文都在 `user` 行里）；正文命中 `A goal has been set.` / `Continue working toward the active thread goal` / `Continue working on` / `The user has set a goal` / `[SYSTEM]` / `<goal>` / `<system>` 开头（忽略大小写）也丢弃——这些是 Agent 自动续跑提示。
5. `response_item` / `event_msg` → 取 `payload.role`/`payload.content`/`payload.message`；`summary` → 助手消息。其它 `type`（如 `workspace-directories`）忽略。
6. 时间：`timestamp` 为 ISO **字符串**时 `Date.parse`（数字则直接用）。输出 `{role,time,text,tool}`，工具名取 `tool_use.name`，`tool_result` 在回放中成为 `result` 事件。

## 状态判定

与 Claude 同族，走 `judgeStatus`：文件 mtime 2 分钟内 → `running`；有 `is_error` 且最后一条真实消息非助手 → `interrupted`；最后一条真实消息是用户 → `waiting`；助手末尾命中 `请确认|需要你|是否继续|等待你|请提供|要我继续` → `waiting`；否则 `completed`；无时间 → `pending`。用户消息间隔 > 30 分钟切成多个任务，只有最后一段可判进行中。

**人工判断**：看最后一条“有正文”的记录；`humanInput` 存在且有内容的行才是真用户提问。工具失败后若无助手收尾即中断，`workspace-directories` 行与 `tool_result` 行都不代表对话进展。

## 坑与注意

- 工具结果回传也在 `type:"user"` 行里，且**只有 `tool_result`、没有正文**；不剔除会让“首条用户消息”被淹没、标题退化成助手消息或“未命名任务”。
- Agent 自动续跑提示由 Agent 自己生成，不是用户输入，必须过滤（正则见上）。
- `isSidechain` 标记的子链记录**没有被过滤**：线性读取会把侧链内容混进主对话，助手/工具计数偏高；需要主链时按该字段自行跳过（代码未实现）。
- `timestamp` 是 ISO 字符串（不是 epoch 毫秒），直接当数字用会得到 1970 年时间。
- 首行 `workspace-directories` 不含 `cwd` 字段；`cwd` 从后续带 `cwd` 的行取，取不到时用 slug 目录名（不可靠）。
- 单会话读取上限 6000 行，实现取文件前 6000 行（注释写“取尾部”，不一致）→ 超长会话可能读不到最新内容，待核实设计意图。
- 坏行 > 50% 时整会话报错、不产出任务；部分坏行只丢该行。
- 只读：不要改写 `.jsonl` 或 `~/.qoder-cn` 下任何文件。

## 引用方式

```
~/.qoder-cn/projects/<路径slug>/<sessionId>.jsonl
```

给编码 agent 的指令：这是 Qoder 的会话 JSONL（与 Claude Code 同源）。逐行解析后按 `timestamp`（ISO 字符串）排序，把 `message.content[]` 还原成 `{role,time,text,tool}`：`text`→正文、`thinking`→思考、`tool_use`→工具调用、`tool_result`→结果；用户行优先用 `humanInput.text`，正文为空的用户行（工具结果回传）与自动续跑提示行一律丢弃；忽略 `workspace-directories` 等非对话记录；存在 `isSidechain` 时说明你是否只保留主线。只读，不改写。