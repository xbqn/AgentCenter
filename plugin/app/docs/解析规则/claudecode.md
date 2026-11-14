# claudecode · Claude Code 会话解析规则

> 适配器 id `claudecode`｜显示名 Claude Code｜存储形态 `JSONL`｜解析家族 `claude-jsonl`
> 依据：`core/adapters.mjs`、`core/parse.mjs`（`extractClaude` / `judgeStatus`）、`core/util.mjs`（`parseJsonl`）、`core/conversation.mjs`（`timelineJsonl`）、`docs/Agent适配器规格.md` §9

## 一句话用途

Claude Code 是 Anthropic 的命令行编码 Agent。它在每个项目目录下按会话写一个 `.jsonl`，每行是带 `type` 的 JSON 记录（用户行、助手行、摘要行），消息正文在 `message.content[]` 里，工具调用与工具结果也是内容块。

## 存储位置

| 平台 | 默认路径 |
|---|---|
| Windows | `~\.claude\projects` |
| macOS | `~/.claude/projects` |
| Linux | `~/.claude/projects` |

- `~` 展开为 `%USERPROFILE%`（Windows）或 `$HOME`（macOS/Linux）；未声明 `base`，适配器根目录取探测到的路径本身。
- 布局：`~/.claude/projects/<路径slug>/<sessionId>.jsonl`；枚举是**递归遍历** `projects` 目录，取其中所有 `.jsonl` 文件，上限 4000 个文件。`~/.claude/history.jsonl` 在 `projects` 之外，**不会被枚举**。
- 路径 slug 规则：项目绝对路径中的 `:\` 与 `\` 转成 `-`（例 `E:\Code\vibeCoding\demo` → `E--Code-vibeCoding-demo`）。
- 旁路/中间目录（只统计，不解析）：`~/.claude/file-history`、`~/.claude/todos`；规格另列 `projects/<slug>/*.backup`。

## 文件格式

- 纯文本 JSONL（无压缩），UTF-8；读取时去掉首字节 BOM，按 `\r?\n` 切分，跳过空行，逐行 `JSON.parse`（坏行计数，不抛出）。
- 会话边界：**一个文件一个会话**；文件内一行一条记录。`sessionId` 取文件名去掉 `.jsonl`；`slug` 取所在目录名。
- 代表记录（字段名取自代码与规格）：

```json
{"type":"user","sessionId":"<uuid>","uuid":"...","parentUuid":null,"cwd":"D:\\work\\demo","timestamp":"2026-10-21T10:50:09.123Z","message":{"role":"user","content":[{"type":"text","text":"检查 start.bat"}]}}
{"type":"assistant","timestamp":"2026-10-21T10:50:12.000Z","message":{"content":[{"type":"thinking","thinking":"先看文件"},{"type":"text","text":"我来检查。"},{"type":"tool_use","name":"Read","input":{"file_path":"start.bat"}}]}}
{"type":"user","timestamp":"2026-10-21T10:50:13.000Z","message":{"content":[{"type":"tool_result","tool_use_id":"...","content":[{"type":"text","text":"...结果..."}]}]}}
{"type":"summary","summary":"修复启动脚本"}
```

## 如何还原成对话

1. 逐行读文件（解析层单会话最多 6000 行，超出按行序截断——实际取的是**前 6000 行**，见“坑”），坏行跳过。
2. 按 `type` 分派：
   - `user` / `assistant` → 取 `message.content`：字符串直接作为正文；数组里 `type:"text"` 拼正文（`part.text`），`type:"thinking"` 拼思考（`part.thinking` 或 `part.text`），`type:"tool_use"` 计一次工具调用（工具名 `part.name`，入参 `part.input`），`type:"tool_result"` 只用于失败判定（`part.is_error`），不进入正文。
   - `user` 行**正文为空就整行丢弃**：工具结果回传也放在 `user` 行里，若不过滤，首条用户消息会被工具结果淹没、标题退化成助手消息。正文命中自动续跑注入（`A goal has been set.` / `Continue working toward the active thread goal` / `Continue working on` / `The user has set a goal` / `[SYSTEM]` / `<goal>` / `<system>` 开头，忽略大小写）也丢弃。
   - `response_item` / `event_msg` → 取 `payload`：`payload.role` 为 `user`/`assistant`，否则按 `tool`；正文取 `payload.content[]` 的 `text` 拼接，或 `payload.message` 字符串。
   - `summary` → 作为一条 `assistant` 消息，正文 `j.summary`（回放时反而作为会话标题）。
   - 其它 `type`（含 compact/边界类记录）→ 忽略，不猜测。
3. 时间：`timestamp` 为数字则直接用，否则 `Date.parse`（ISO 字符串）。`cwd`、`sessionId` 取行内字段（后出现的覆盖先出现的）。
4. 输出 `{role,time,text,tool}`：用户/助手/`think`/`tool`/`result`；工具事件用 `tool_use` 的 `name`（回放里 `tool` 字段就是该名），`tool_result` 在回放中作为 `result` 事件输出。

## 状态判定

`judgeStatus`：文件 mtime 2 分钟内 → `running`；有 `is_error` 且最后一条真实消息不是助手 → `interrupted`；最后一条真实消息是用户 → `waiting`；助手末尾命中 `请确认|需要你|是否继续|等待你|请提供|要我继续` → `waiting`；否则 `completed`，无时间则 `pending`。任务切分按“用户消息间隔 > 30 分钟”切段，只有最后一段可能判为进行中。

**人工判断**：看最后一条非 `tool_result` 记录的 `type`；`assistant` 收尾且无 `is_error` 即已完成，`user` 结尾即等待，出现工具失败且之后没有助手文本即中断。`summary` 行不代表对话结束。

## 坑与注意

- 工具结果与用户提问共用 `type:"user"`，必须靠“正文是否为空”区分；只按 type 统计会把工具结果数成用户消息。
- `summary` 行在解析层被当作助手消息（会进入消息计数与待办抽取），在回放层被当作标题——两处语义不同，跨层对账时不要重复计。
- `parentUuid` 用于分支重建，但解析代码**没有**用它；若文件里存在分叉/重放记录，线性读会把多条分支混在一起 → 需要分支视图时按 `parentUuid` 自行重建（代码未实现）。
- 单会话读取上限 6000 行，`readLines` 实现是“读满即停”，即取**文件开头**的 6000 行，而注释写“超出取尾部”——两者不一致，超长会话的实际行为以代码为准（可能读不到最新对话）→ 待核实设计意图。
- `~/.claude/history.jsonl`（规格列为备选）不参与枚举；若用自定义适配器把根路径指到这个文件，`walkFiles` 对文件路径会因 `readdir` 失败返回空 → 实际读不到任何会话（是否需要单文件特殊处理 **待核实**）。
- 非 UTF-8 或二进制混入会产生替换字符，导致该行 JSON 解析失败并计入坏行；坏行 > 50% 时整会话报错。
- 全程只读：不要写回 `.jsonl`，不要改写 `~/.claude` 下的任何文件。

## 引用方式

```
~/.claude/projects/<路径slug>/<sessionId>.jsonl
```

给编码 agent 的指令：这是 Claude Code 的会话 JSONL，一行一条记录。请逐行解析后按 `timestamp` 排序，把 `type:"user"`/`"assistant"` 的 `message.content[]` 还原成 `{role,time,text,tool}`：`text`→正文，`thinking`→思考，`tool_use`→工具调用（`name`/`input`），`tool_result`→结果；正文为空的 `user` 行是工具结果回传或注入上下文，必须丢弃；`summary` 行单独当作标题；无法识别的 `type` 忽略。只读该文件，不要改写。