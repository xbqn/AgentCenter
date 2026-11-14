# codebuddy · CodeBuddy 会话解析规则

> 适配器 id `codebuddy`｜显示名 CodeBuddy｜存储形态 `SQLite`｜解析家族 `vscdb`
> 依据：`core/adapters.mjs`（路径 / `listSessions` 的 vscdb 分支）、`core/parse.mjs`（families `vscdb` 分支）、`core/conversation.mjs`（`timelineVscdb`）、`docs/Agent适配器规格.md` §1

## 一句话用途

CodeBuddy（IDE 系）把会话的**元信息**写进 VS Code 同构的 SQLite 库 `codebuddy-sessions.vscdb`（`ItemTable` 表，键形如 `session:<id>`），消息正文保存在 IDE 内部存储里，无法只读解析。因此 AgentCenter 对它只产出“元信息任务”。

## 存储位置

| 平台 | 默认路径 |
|---|---|
| Windows | `%APPDATA%\CodeBuddy CN\codebuddy-sessions.vscdb`（首选）、`%APPDATA%\CodeBuddy\codebuddy-sessions.vscdb`（备选） |
| macOS | `~/Library/Application Support/CodeBuddy CN/codebuddy-sessions.vscdb` |
| Linux | `~/.config/CodeBuddy CN/codebuddy-sessions.vscdb` |

- `%APPDATA%` 展开为 `C:\Users\<用户>\AppData\Roaming`（缺失时退回 `~\AppData\Roaming`）；`~` 为 `%USERPROFILE%` / `$HOME`。
- 会话源是**单个库文件**，不是目录：`sessionId` 来自库内每条记录，`sourceFile` 记为 `<库路径>#session=<id>`。
- 适配器根目录（中间文件基准）：Windows `%APPDATA%\CodeBuddy CN`、macOS `~/Library/Application Support/CodeBuddy CN`、Linux `~/.config/CodeBuddy CN`。
- 中间文件目录（只统计）：`blob_storage`、`Cache`、`Code Cache`、`GPUCache`、`Backups`。

## 文件格式

- SQLite 数据库（只读打开，`node:sqlite` 的 `DatabaseSync(file, {readOnly:true})`）。
- 会话粒度：`ItemTable` 中 **一行一个会话**，`key` 以 `session:` 开头，`value` 是 JSON 字符串。
- 代表记录（`value` 反序列化后的字段，取自 `listSessions` 实际读取的键）：

```json
{"conversationId":"<会话id>","title":"修复登录超时","cwd":"D:\\work\\demo","status":"completed","createdAt":"2026-10-21T10:50:09.000Z","updatedAt":"2026-10-21T11:20:00.000Z"}
```

- 读取的字段只有 `conversationId`、`title`、`cwd`、`status`、`createdAt`、`updatedAt`；其余字段未使用，完整 schema **待核实**。

## 如何还原成对话

1. 只读打开库：`select key, value from ItemTable where key like 'session:%'`；打不开（锁 / 非 SQLite / WAL 不可读）时退化为一条 `unavailable` 记录，`sessionId: 'vscdb'`。
2. 逐行 `JSON.parse(value)`；坏 JSON 直接跳过该行，不报错。
3. `sessionId` 优先 `value.conversationId`，缺失时取 `key` 去掉 `session:` 前缀。
4. 时间：`createdAt` / `updatedAt` 先 `Date.parse`，失败再按 `Number(...)` 当 epoch 毫秒；缺失记 0。
5. **正文无法还原**：`timelineVscdb` 只按 `session:<id>` 回读同一条元信息，返回 `events: []`、`unavailable: true`，并附注“该 Agent（IDE 系）只把会话元信息写进 SQLite，消息正文保存在 IDE 内部存储中，无法只读解析”。
6. 因而不存在 user/assistant/thinking/tool 映射，也没有工具名可提取；需要对话原文时到 IDE 自身的 UI 里看，或改用该 Agent 的 CLI 侧 JSONL（见“坑”）。

## 状态判定

不走 `judgeStatus`，直接用库内 `status` 文本正则：

- `complete|done|finished` → `completed`
- `run|active|progress` → `running`
- `wait|pending|input` → `waiting`
- 其它/缺失 → 默认 `completed`

`statusReason` 固定为 `IDE 会话状态：<原始 status>（正文存于 IDE 内部存储，H5 只读元信息）`。活跃时长：墙钟 ≤ 15 分钟时用墙钟，否则记 0（未知）；墙钟 = `updatedAt - createdAt`。

**人工判断**：看 `value.status` 与会话时间跨度；文件 mtime 落在 2 分钟内**不会**判为进行中（vscdb 不参与 `judgeStatus`），所以别用“库文件刚被写过”推断进行中。正文是否仍在跑只能看 IDE。

## 坑与注意

- 只有元信息：消息数、工具调用数恒为 0，`todos` 为空，`lastMessagePreview` 为空——这是数据形态决定的，不是解析失败。
- `ItemTable` 里其它键（窗口状态、最近工作区等）不读；只匹配 `session:%` 前缀，键名规则变化会导致 0 个会话。
- 共享库体积按会话数平摊（`storageBytes` 取平摊值），不是单个会话真实占用。
- SQLite 为只读打开；若库处于 WAL 模式且 `-wal`/`-shm` 不可读，会打不开并降级为 `unavailable`，不要尝试写或“修复”源库。
- 规格 §1 记载 CodeBuddy CLI 侧 `~/.codebuddy/projects/` 为 JSONL 会话，但适配器表中**没有**这条路径，代码也不解析 → 若要用 CLI 会话，需自建自定义适配器；两份数据是否同源 **待核实**。
- 全程只读：不要 `VACUUM`、不要打开写连接、不要移动库文件。

## 引用方式

```
%APPDATA%\CodeBuddy CN\codebuddy-sessions.vscdb   # 会话 id 记作 <库路径>#session=<id>
```

给编码 agent 的指令：这是 CodeBuddy 的 SQLite 会话库（`ItemTable`，`key like 'session:%'`，`value` 为 JSON）。请以只读方式打开，逐行解析 `value` 得到 `conversationId/title/cwd/status/createdAt/updatedAt`，按 `createdAt` 排序；该库只有会话元信息，**没有消息正文**，不要臆造对话内容——需要正文时说明“正文在 IDE 内部存储中不可读”，或改读该 Agent 的 CLI JSONL。不要写库。