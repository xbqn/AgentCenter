# deepseek · DeepSeek Harness 会话解析规则

> 适配器 id `deepseek`｜显示名 DeepSeek Harness｜存储形态 `zstd JSONL`｜解析家族 `dsh`
> 依据：`core/adapters.mjs`、`core/parse.mjs`（`extractDsh` / `judgeStatus`）、`core/util.mjs`（`decompressZstdFrames`）、`core/conversation.mjs`（`timelineDsh`）

## 一句话用途

DeepSeek Harness（DSH）是本机 Agent 运行时。一个会话就是一个目录，正文是**多帧追加的 zstd 压缩 JSONL 事件流**：不是一份聊天记录，而是 `user/message`、`assistant/message`、`tool/call`、`tool/result`、`turn/end` 等事件按时间顺序追加。

## 存储位置

| 平台 | 默认路径 |
|---|---|
| Windows | `~\.dsh\sessions` |
| macOS | `~/.dsh/sessions` |
| Linux | `~/.dsh/sessions` |

- `~` 展开为 Windows `%USERPROFILE%`、macOS/Linux `$HOME`；适配器根目录（中间文件基准）为 `~/.dsh`。
- 布局：`~/.dsh/sessions/<项目slug>/<会话目录>/session[.vN].jsonl[.zstd]`。
- 会话目录名为 `session-<uuid>`（也兼容裸 `<uuid>` 目录）；`sessionId` = 目录名去掉 `session-` 前缀。
- 代际命名：v0 → `session.jsonl`；vN → `session.vN.jsonl`；压缩后追加 `.zstd`。同一目录可能有多代，**必须取版本最高的一代**；同版本优先 `.zstd`。
- 中间文件目录（只统计、不解析）：`attachments`、`storages`、`dsh-runtimes`。

## 文件格式

- 压缩：zstd **多帧拼接**——每次追加各压一帧再顺序拼接。对整文件调一次解压只能得到第一帧，流式解压也在第一帧结束处停止；正确做法是按帧头/块头扫描出精确边界后逐帧解压再拼接。
- 解压后是 UTF-8 JSONL：一行一个 JSON 事件，按 `\r?\n` 切分，空行跳过。不做 BOM 去除。
- 会话边界：**目录即会话**；目录中存在多个代际文件时只有最高版本是权威数据。每行是“事件”，不是“消息”。
- 代表记录（字段名取自解析代码）：

```json
{"type":"session","version":3,"id":"<sessionId>","createdAt":1762250000000,"cwd":"D:\\work\\demo"}
{"type":"session/title","time":1762250000001,"data":{"title":"修复登录超时"}}
{"type":"user/message","time":1762250010000,"data":{"content":[{"type":"text","text":"看一下登录为什么超时"}],"source":{"kind":"user"}}}
{"type":"assistant/message","time":1762250020000,"data":{"message":{"content":[{"type":"reasoning","text":"先读配置"},{"type":"text","text":"我来查。"},{"type":"tool-call","name":"read","arguments":"{\"path\":\"a.ts\"}"}]}}}
{"type":"tool/call","time":1762250021000,"data":{"name":"read"}}
{"type":"tool/result","time":1762250022000,"data":{"message":{"content":[{"type":"text","text":"..."}]}}}
{"type":"turn/end","time":1762250090000,"data":{"reason":{"kind":"completed"}}}
{"type":"todo/write","time":1762250091000,"data":{"todos":[{"content":"补测试","status":"completed"}]}}
```

## 如何还原成对话

1. 用帧扫描 + 逐帧解压得到全文；全文为空即“解压失败（帧数/坏帧数）”，不产出任务。
2. 逐行 `JSON.parse`；坏行计数，坏行超过总行数一半则整会话报错，不产出任务。
3. 按文件顺序折叠事件（`time` 为 epoch 毫秒）：
   - `session` → 取 `cwd`（顶层 `cwd`，不在 `data` 里）；`id`/`createdAt` 可作会话标识与起始时间。
   - `session/title` → `data.title` 作为会话标题。
   - `user/message` → `data.content[]` 中 `type:"text"` 的 `text` 拼接为用户正文；`data.source.kind === "plugin"`、正文以 `Current runtime context.` / `Time sampled while preparing turn` / `You are an AI agent` / `Current DSH file policy` 开头、或含 `<system-reminder` 的，都是注入上下文，**不是用户提问**，丢弃；正文为空也丢弃。
   - `assistant/message` → `data.message.content[]`：`text` 拼为助手正文，`reasoning` 拼为思考，`tool-call` 每个计一次工具调用（工具名 `name`，入参 `arguments`）。解析层把 `text || reasoning` 作为助手文本，因此只有思考、没有正文的轮次也会计入助手消息。
   - `tool/call` → 工具事件，工具名 `data.name`。
   - `tool/result` → 工具结果事件；把 `data.message.content` 序列化后匹配 `"isError":true`、`is_error`、`"error"` 判定失败。
   - `turn/end` → 仅当 `data.reason.kind` 为 `error` 或 `aborted` 时记一次工具失败标记；`completed` 不产生事件。
   - 未知 `type`：忽略（不报错、不猜测语义），只保留已知事件。
4. 输出时间线 `{role,time,text,tool}`：`role` 取 `user` / `assistant` / `think` / `tool` / `result` / `todo`；`time` 由 epoch 毫秒格式化为本地 `HH:mm`（回放）或 ISO 8601（任务起止）。工具事件 `tool` 字段填工具名。

## 状态判定

`judgeStatus`（仅最后一个分段可能判为进行中）依次判断：

1. 心跳：`data/config.json` 的 `agents.deepseek.heartbeatMs` 在 60 秒内 → `running`。DSH 会话文件里没有心跳记录，此值只能由配置/外部写入 → 通常为空。
2. 会话文件 mtime 在 2 分钟内 → `running`（“最近一次写入 N 秒前”）。
3. 有工具失败且最后一条真实消息不是助手 → `interrupted`。
4. 最后一条真实消息是用户 → `waiting`（等待助手响应）。
5. 助手末尾命中 `请确认|需要你|是否继续|等待你|请提供|要我继续` → `waiting`。
6. 否则 → `completed`（24 小时内为“助手正常收尾”，更早为“会话已结束”）；完全没有时间 → `pending`。

**人工判断**：看解压后最后一行的 `type` 与 `turn/end.data.reason.kind`；`error`/`aborted` 结尾即中断，`user/message` 结尾即等待，文件 2 分钟内被写过即进行中。注意代际：只看最高版本文件，旧代际的 mtime 不代表当前状态。

## 坑与注意

- 多帧 zstd 是最大的坑：常规解压只得到第一帧（实测 217 字节 vs 压缩后 2.2 MB 的差距），会误判“会话为空”。
- 末尾被截断的帧（torn）会用 flush 模式抢救，仍可能丢掉最后半条记录 → 最后一行 JSON 不完整，只能计入坏行，不要整份丢弃。
- 坏行 > 50% 时解析器直接报错，任务不会出现在索引里；排查时先看帧扫描是否抛 `invalid zstd frame magic` / `reserved ... bit`。
- 同目录 `session.jsonl` 与 `session.v3.jsonl.zstd` 并存时，取 v3；把旧代际当正文会得到过期对话。
- 项目 slug 目录名中的 `-` 既是路径分隔符也是文件名连字符，**无法反解 cwd**；真实 cwd 只能从 `session` 行的 `cwd` 读取。
- 大文件整份读入内存并逐帧解压，内存约等于“压缩体积 + 解压后明文”；DSH 路径没有行数上限。
- 全程只读源目录，不要重写、不要就地解压覆盖 `.zstd`。
- `data.source.kind` 除 `plugin` 外的其它取值未在解析代码中枚举 → 待核实。

## 引用方式

```
~/.dsh/sessions/<项目slug>/session-<uuid>/session.vN.jsonl.zstd
```

给编码 agent 的指令：这是 DeepSeek Harness 的会话文件，**多帧 zstd 压缩的 JSONL 事件流**。请按帧头扫描出边界后逐帧解压、拼接成 UTF-8 文本，再逐行 `JSON.parse`；按 `time` 升序把 `user/message` / `assistant/message`（`text`、`reasoning`、`tool-call`）/ `tool/call` / `tool/result` / `todo/write` 还原成 `{role,time,text,tool}` 时间线，跳过 `source.kind:"plugin"` 与运行时注入的上下文；同目录存在多个 `session.vN.jsonl[.zstd]` 时只读版本最高的那一代，坏行与截断尾帧按缺失处理，不要修改源文件。