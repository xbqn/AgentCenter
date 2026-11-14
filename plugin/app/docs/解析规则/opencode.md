# opencode · OpenCode 会话解析规则

> 适配器 id `opencode`｜显示名 OpenCode｜存储形态 `SQLite`｜解析家族 `opencode-db`
> 依据：`core/adapters.mjs`、`core/parse.mjs`（`opencode-db` 分支）、`core/conversation.mjs`（`timelineOpencode`）、`core/util.mjs`（`openSqlite`）、`docs/Agent适配器规格.md` §5

## 一句话用途

OpenCode 把会话、消息、消息片段都存进一个 SQLite 库 `~/.local/share/opencode/opencode.db`：`session` 表存会话，`message` 表存消息（JSON 在 `data` 列），`part` 表存正文/思考/工具片段，`todo` 表存会话级待办。一个库包含全部会话。

## 存储位置

| 平台 | 默认路径 |
|---|---|
| Windows | `~\.local\share\opencode` |
| macOS | `~/.local/share/opencode` |
| Linux | `~/.local/share/opencode` |

- `~` 展开为 `%USERPROFILE%`（Windows）或 `$HOME`（macOS/Linux）。
- 会话源 = 该目录下的 `opencode.db`（`root/opencode.db`）；目录不存在或 `opencode.db` 不是文件则视为未安装。
- 未声明 `base`：适配器根目录取 `~/.local/share/opencode`。
- 中间文件目录（只统计）：`tool-output`、`snapshot`、`log`、`repos`。规格另记 `storage`（`migration`/`session_diff`）与 `shell`。

## 文件格式

- SQLite（只读打开；WAL 模式）。四张表被读取：
  - `session(id, slug, title, directory, time_created, time_updated)`
  - `message(id, session_id, data, time_created)` — `data` 是 JSON 字符串，含 `role`
  - `part(message_id, session_id, data)` — `data` 是 JSON 字符串，含 `type`（`text` / `reasoning` / `tool`）
  - `todo(session_id, content, status)`
- 会话边界：**一个 `session` 行一个会话**；消息按 `session_id` 归属，片段按 `message_id` 归属。`sourceFile` 记为 `<db 路径>#session=<id>`。
- 代表记录（`message.data` 与 `part.data` 反序列化后的字段）：

```json
{"role":"user","content":[]}
{"role":"assistant"}
{"type":"text","text":"我来检查 start.bat"}
{"type":"reasoning","text":"先看文件内容"}
{"type":"tool","tool":"bash","state":{"status":"error","input":{"cmd":"dir"},"output":"..."}}
```

## 如何还原成对话

1. 只读打开库（打不开时整会话报错“SQLite 无法打开（可能是 WAL 锁）”）。
2. `select id, data, time_created from message where session_id = ? order by time_created`；`select data, message_id from part where session_id = ?`，按 `message_id` 分组，组内保持查询返回顺序。
3. 逐条消息：`data.role === "user"` 才是用户，其它按助手；时间用 `message.time_created`（epoch 毫秒）。`data` 坏 JSON 跳过该消息。
4. 逐条片段：`type:"text"` → 正文；`type:"tool"` → 工具事件（工具名 `part.tool`，入参 `part.state.input`），`part.state.status === "error"` 标记失败；`type:"reasoning"` → 思考（回放层输出 `think`，解析层不计入正文）。
5. 解析层的消息正文只拼 `text` 片段，工具调用只计数；回放层额外把 `tool.state.output` 输出为 `result` 事件，并把 `state.input` 序列化进 `tool` 事件文本。
6. `todo` 表按 `session_id` 读 `content`/`status`，`status === "completed"` 视为已完成，合并进任务的 `todos`（去重）。
7. 未知 `part.type` 忽略；未知 `message.data` 结构按助手处理（只认 `role`）。

## 状态判定

走 `judgeStatus`：库文件 mtime 2 分钟内 → `running`（注意：共享库，任一会话写入都会刷新这个 mtime）；有工具失败且最后一条真实消息不是助手 → `interrupted`；最后一条真实消息是用户 → `waiting`；助手末尾命中 `请确认|需要你|是否继续|等待你|请提供|要我继续` → `waiting`；否则 `completed`；无时间 → `pending`。无心跳来源。用户消息间隔 > 30 分钟切段。

**人工判断**：看 `session.time_updated` 与最后一条 `message` 的 `role`；最后一条是 `user` 即等待，`assistant` 且无 `state.status="error"` 即完成。因为库是共享的，**不要**用库文件 mtime 判断某个具体会话是否在进行。

## 坑与注意

- `data` 列是 JSON 字符串，不是结构化列；解析失败只能跳过该行，不要据此判断会话损坏。
- `part` 与 `message` 分表：只读 `message` 会得到空正文，必须按 `message_id` 关联 `part`。
- 工具片段同时含 `state.input` 与 `state.output`；解析层只计数不计正文，回放层才会展开，两处统计口径不同。
- 共享库：所有会话的 `sourceFile` 都是同一个 `.db`（用 `#session=` 区分），库体积按会话数平摊；库 mtime 不能归因到单个会话。
- 只读打开依赖 `node:sqlite`（Node 内置），环境不支持时返回 `null`，会话退化为 `unavailable`；WAL 模式下 `-wal`/`-shm` 不可读也会打不开。
- 全程只读：不要 `VACUUM`、不要写连接、不要移动 `.db`。
- 规格提到的 `storage`/`shell` 目录不在 `intermediates` 列表里，只计入 Agent 根目录总占用。

## 引用方式

```
~/.local/share/opencode/opencode.db   # 会话 id 记作 <db 路径>#session=<id>
```

给编码 agent 的指令：这是 OpenCode 的 SQLite 会话库。请只读打开，按 `session` 行的 `id` 取会话，按 `time_created` 读 `message`，再按 `message_id` 关联 `part`；把 `part.data` 的 `type:"text"` 还原为正文、`"tool"` 还原为工具事件（`tool`/`state.input`/`state.output`/`state.status`）、`"reasoning"` 还原为思考，`role` 取 `message.data.role`，时间取 `message.time_created`；`todo` 表补待办。输出 `{role,time,text,tool}`。不要写库，也不要依赖库文件 mtime 判断会话活跃。