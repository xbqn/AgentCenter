# codex · Codex CLI 会话解析规则

> 适配器 id `codex`｜显示名 Codex CLI｜存储形态 `JSONL`｜解析家族 `claude-jsonl`
> 依据：`core/adapters.mjs`、`core/parse.mjs`（`extractClaude` 的 `response_item` / `event_msg` / `summary` 分支）、`docs/Agent适配器规格.md` §8

## 一句话用途

Codex CLI 是 OpenAI 的命令行编码 Agent。它把每次会话写成 `.jsonl` 的 rollout 记录，核心行类型是 `response_item` / `event_msg`（正文在 `payload` 里）、`session_meta`，以及 `summary`；适配器按 Claude 家族解析器读取。

## 存储位置

| 平台 | 默认路径 |
|---|---|
| Windows | `~\.codex\sessions`、`~\.codex\history.jsonl` |
| macOS | `~/.codex/sessions` |
| Linux | `~/.codex/sessions` |

- `~` 展开为 `%USERPROFILE%`（Windows）或 `$HOME`（macOS/Linux）。
- 会话在 `~/.codex/sessions` 下按日期分层（常见 `sessions/YYYY/MM/DD/rollout-*.jsonl`）；枚举**递归遍历**该目录取所有 `.jsonl`，上限 4000。
- Windows 的备选路径 `~\.codex\history.jsonl` 是**单文件**：`walkFiles` 对文件路径会因 `readdir` 失败返回空，因此 `sessions` 目录不存在而只命中它时，实际枚举不到会话（是否需要单文件特殊处理 **待核实**）。
- `sessionId` = 文件名去掉 `.jsonl`，`slug` = 上级目录名（日期目录名，不是项目名）。
- 未声明 `base` 与中间文件目录。

## 文件格式

- 纯文本 JSONL，UTF-8；读时去 BOM、按 `\r?\n` 切分、跳空行、逐行 `JSON.parse`，坏行计数。
- 会话边界：**一个 rollout 文件一个会话**；`history.jsonl` 是跨会话的提问历史（扁平列表，结构见“待核实”）。
- 代表记录（字段名取自解析代码；`payload` 内部字段按代码读取顺序给出）：

```json
{"type":"session_meta","payload":{"id":"<uuid>","cwd":"D:\\work\\demo"}}
{"type":"response_item","timestamp":"2026-10-21T10:50:09.123Z","payload":{"role":"user","content":[{"type":"text","text":"检查 start.bat"}]}}
{"type":"response_item","payload":{"role":"assistant","content":[{"type":"text","text":"我来检查。"}]}}
{"type":"event_msg","payload":{"message":"工具执行完成"}}
{"type":"summary","summary":"修复启动脚本"}
```

- 解析代码只读 `payload.role` / `payload.content[].text` / `payload.message`；`payload.type`、`name`、`arguments` 等工具字段未被读取 → 工具调用无法从该分支还原，见“坑”。

## 如何还原成对话

1. 逐行读（单会话上限 6000 行），坏行跳过。
2. `type === "response_item"` 或 `"event_msg"` → 取 `j.payload`：`payload.role === "user"` 记用户，`"assistant"` 记助手，其它（含缺失）记 `tool`；正文优先 `payload.content[]` 各元素的 `text` 拼接，否则用 `payload.message` 字符串。
3. `type === "user" || "assistant"` 的 Claude 形态行同样被支持：`message.content[]` 中 `text`/`thinking`/`tool_use`/`tool_result`。
4. `type === "summary"` → 一条助手消息，正文 `j.summary`（回放时作为标题）。
5. `session_meta` 与其它未知类型 → 忽略。时间：`timestamp` 数字直接用，字符串 `Date.parse`；`cwd`/`sessionId` 从行内字段取（`session_meta` 的 `payload.cwd` **不会**被读到，代码只认顶层 `cwd`）。
6. 输出 `{role,time,text,tool}`；工具事件只有在 Claude 形态行里才能拿到工具名。

## 状态判定

走 `judgeStatus`：文件 mtime 2 分钟内 → `running`；工具失败且最后一条真实消息不是助手 → `interrupted`；最后一条真实消息是用户 → `waiting`；助手末尾命中 `请确认|需要你|是否继续|等待你|请提供|要我继续` → `waiting`；否则 `completed`；无时间 → `pending`。Codex 无心跳来源。用户消息间隔 > 30 分钟切段，只有最后一段可判进行中。

**人工判断**：看最后一条 `response_item` 的 `payload.role`；`assistant` 收尾即完成，`user` 结尾即等待，rollout 文件 2 分钟内被写过即进行中。`summary` 行不代表对话结束。

## 坑与注意

- Codex 的工具调用通常在 `payload.type` 为函数调用/输出类记录里，而解析代码**只读 `role`/`content`/`message`** → 工具调用数与工具名可能缺失；需要完整工具视角时按 `payload` 实际结构补充解析。
- `session_meta.payload.cwd` 不被读取（代码只认顶层 `cwd`），因此任务的项目名可能退化为目录名（日期目录）→ 人工判断时从文件内 `payload.cwd` 取值。
- `role` 缺失的 `response_item` 会被当成 `tool`，可能凭空多出工具事件。
- `history.jsonl` 不在 `sessions` 下，正常不会被枚举；作为备选根路径命中时又会因“单文件不是目录”枚举为空。它的记录结构（是否有 `role`/`content`）代码未约定 → **待核实**，不要按 rollout 结构硬解。
- 递归枚举会把日期目录下的所有 `.jsonl` 都算会话，包括可能的中间文件。
- 单会话读取上限 6000 行，实现取文件**前** 6000 行（注释写“取尾部”，不一致）→ 超长 rollout 可能缺最新内容，待核实设计意图。
- 坏行 > 50% 时整会话报错；只读，不改写 `.jsonl`。

## 引用方式

```
~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl
```

给编码 agent 的指令：这是 Codex CLI 的会话 rollout JSONL。逐行 `JSON.parse` 后按 `timestamp` 排序：`response_item`/`event_msg` 取 `payload.role`、`payload.content[].text`、`payload.message` 还原为 `{role,time,text,tool}`；`summary` 作为标题；`session_meta` 只取元信息。工具调用若在 `payload.type` 等未被识别的字段里，请先报告实际结构再补映射，不要猜。只读该文件，不改写。