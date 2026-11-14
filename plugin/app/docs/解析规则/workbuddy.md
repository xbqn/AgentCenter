# workbuddy · WorkBuddy 会话解析规则

> 适配器 id `workbuddy`｜显示名 WorkBuddy｜存储形态 `JSONL`｜解析家族 `workbuddy`
> 依据：`core/adapters.mjs`、`core/parse.mjs`（`extractWorkbuddy` / `judgeStatus`）、`core/util.mjs`、`docs/Agent适配器规格.md` §3

## 一句话用途

WorkBuddy 的会话按项目目录存放，每个会话一个 `.jsonl`。行是带 `type` 的 JSON：`session-meta` 记录会话元信息与心跳时间戳，`message` 承载对话，`function_call`/`function_call_result` 承载工具调用与结果。

## 存储位置

| 平台 | 默认路径 |
|---|---|
| Windows | `~\.workbuddy\projects` |
| macOS | `~/.workbuddy/projects` |
| Linux | `~/.workbuddy/projects` |

- `~` 展开为 `%USERPROFILE%`（Windows）或 `$HOME`（macOS/Linux）；适配器根目录为 `~/.workbuddy`。
- 布局：`~/.workbuddy/projects/<项目路径slug>/<sessionId>.jsonl`；枚举**只下沉一层**：`projects` 下每个子目录里直接以 `.jsonl` 结尾的文件才算会话（不递归更深层），上限 4000。
- slug 规则：项目路径中的 `:\` 与 `\` 转成 `-`（规格示例 `D-Users-dev-WorkBuddy-2026-10-21-10-50-09`）；解析时用 `slugToPath` 近似还原出 `D:\...`，仅用于展示。
- 旁路/中间目录（只统计）：`file-history`、`blobs`、`clipboard-images`、`artifact-index`、`changes-index`、`changes-detail`；同目录另有 `*.file-rollback.ndjson`（回滚快照）。

## 文件格式

- 纯文本 JSONL，UTF-8；读时去 BOM、按 `\r?\n` 切分、跳空行、逐行 `JSON.parse`，坏行计数不抛出。
- 会话边界：**一个文件一个会话**；`sessionId` = 文件名去掉 `.jsonl`，`slug` = 所在项目目录名。
- 代表记录（字段名取自解析代码与规格实测样本）：

```json
{"type":"session-meta","id":"01a15c5d-...","sessionId":"af5b5438-...","timestamp":1792551021304,"meta":{"codebuddy.ai/hostKind":"unopted"}}
{"type":"message","role":"user","timestamp":1792551022000,"content":[{"type":"input_text","text":"检查 start.bat"}]}
{"type":"message","role":"assistant","timestamp":1792551025000,"content":[{"type":"text","text":"我来检查。"},{"type":"tool_use","name":"Read","input":{"path":"start.bat"}}]}
{"type":"function_call","name":"Read","arguments":"{\"path\":\"start.bat\"}","timestamp":1792551025000}
{"type":"function_call_result","name":"Read","timestamp":1792551026000,"output":{"text":"…"}}
```

## 如何还原成对话

1. 逐行读（单会话上限 6000 行），坏行跳过。
2. `type === "message"`：`role` 只要 `user` 才是用户，其余一律按助手；`content[]` 中 `input_text`/`text` 拼正文，`tool_use` 每个计一次工具调用（工具名 `name`、入参 `input`），`tool_result` 仅看 `is_error` 判定失败。
3. 用户正文命中 `<system-reminder` / `<user_info>` / `<identity_context>` 时，先删掉 `<system-reminder>…</system-reminder>` 段、再把标签替换为空格并压缩空白；清洗后为空则丢弃——这类是上下文注入，不是真实提问。
4. `type === "function_call"` 或 `"tool_use"` → 工具事件，工具名取 `j.name`。
5. `type === "function_call_result"` → 工具结果；把 `j.output` 序列化后匹配 `<tool_use_error>` 判定失败。
6. `type === "session-meta"` → 不产生消息，但取 `timestamp` 更新心跳时间（取最大值）。
7. 其它类型 → 忽略。时间字段是 `timestamp`（epoch 毫秒），缺失时退回 `time`。
8. 输出 `{role,time,text,tool}`；回放层还会把 `tool_result.content`（字符串或数组中的 `text`）输出为 `result` 事件，工具调用输出为 `tool` 事件。

## 状态判定

`judgeStatus`：心跳 60 秒内或文件 mtime 2 分钟内 → `running`；工具失败且最后一条真实消息不是助手 → `interrupted`；最后一条真实消息是用户 → `waiting`；助手末尾命中 `请确认|需要你|是否继续|等待你|请提供|要我继续` → `waiting`；否则 `completed`；无时间 → `pending`。

- 心跳来源：`session-meta` 行的 `timestamp`；扫描器还会把 `data/config.json` 里 `agents.workbuddy.heartbeatMs` 与它取较大值。
- 任务切分：用户消息间隔 > 30 分钟切段，只有最后一段可能判进行中。

**人工判断**：看最后一条 `message` 的 `role`；末尾 `session-meta` 的时间越新越可能仍在写。规格提到的进程心跳文件 `~/.workbuddy/sessions/<pid>.json`（`lastHeartbeat`）**没有被代码读取**，手工判断时可参考，但不要当作 AgentCenter 的判定依据。

## 坑与注意

- 用户消息里的注入上下文（`<system-reminder>` / `<user_info>` / `<identity_context>`）必须清洗；只删标签不删内容会把系统提示算进用户提问。
- 工具调用可能以 `function_call` 顶层行出现，也可能嵌在 `message.content[]` 的 `tool_use` 里，两处都要计，否则工具调用数偏少。
- 工具失败只在 `function_call_result.output` 里以 `<tool_use_error>` 文本体现，没有独立 error 字段。
- 枚举只扫 `projects/<slug>/*.jsonl` 一层；更深层目录或 `*.file-rollback.ndjson` 不算会话。
- 同一 `sessionId` 可能出现在多个项目目录下（UUID 复用），`taskId` 靠 `sessionId@上级目录名` 去重——按会话聚合时要带上目录。
- 单会话读取上限 6000 行，实现取文件**前** 6000 行（注释写“取尾部”，不一致）→ 超长会话可能缺最新内容，待核实设计意图。
- 坏行 > 50% 时整会话报错、不产出任务；只读，不要改写 `.jsonl`。

## 引用方式

```
~/.workbuddy/projects/<项目路径slug>/<sessionId>.jsonl
```

给编码 agent 的指令：这是 WorkBuddy 的会话 JSONL。逐行解析后按 `timestamp`（epoch 毫秒）排序：`type:"message"` 的 `content[]` 里 `input_text`/`text` 是正文、`tool_use` 是工具调用、`tool_result` 是结果；`function_call`/`function_call_result` 是另一形态的工具调用与结果；`session-meta` 只取时间做心跳。用户正文里的 `<system-reminder>` 等注入内容要清洗后丢弃。输出 `{role,time,text,tool}`，无法识别的 `type` 忽略。只读该文件，不改写。