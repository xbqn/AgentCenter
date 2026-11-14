# trae · Trae 会话解析规则

> 适配器 id `trae`｜显示名 Trae｜存储形态 `SQLite`｜解析家族 `vscdb`
> 依据：`core/adapters.mjs`（路径 / `listSessions` 的 vscdb 分支）、`core/parse.mjs`（`vscdb` 分支）、`core/conversation.mjs`（`timelineVscdb`）、`docs/Agent适配器规格.md` §2

## 一句话用途

Trae 是 IDE 系编码 Agent，会话历史存在 VS Code 同构的 `state.vscdb`（SQLite）里，`ItemTable` 中以 `session:` 开头的键对应会话，`value` 是 JSON。适配器只读这些元信息，正文在 IDE 内部存储中不可读。

## 存储位置

| 平台 | 默认路径 |
|---|---|
| Windows | `%APPDATA%\Trae\User\globalStorage\state.vscdb`（首选）、`%LOCALAPPDATA%\Trae\User\globalStorage\state.vscdb`（备选） |
| macOS | `~/Library/Application Support/Trae/User/globalStorage/state.vscdb` |
| Linux | `~/.config/Trae/User/globalStorage/state.vscdb` |

- `%APPDATA%` = `C:\Users\<用户>\AppData\Roaming`；`%LOCALAPPDATA%` = `C:\Users\<用户>\AppData\Local`；`~` = `%USERPROFILE%` / `$HOME`。
- 会话源是单个库文件：`sourceFile` 记为 `<库路径>#session=<id>`。
- 未声明 `base`：适配器根目录取库文件所在目录（即 `...\User\globalStorage`）；中间文件目录 `User` 相对该根目录计算（通常不存在，只统计）。
- 规格另记备选 `~\.trae\`，适配器表未收录这条路径。

## 文件格式

- SQLite 数据库（只读打开，`node:sqlite` `DatabaseSync`，`readOnly: true`）。
- 会话粒度：`ItemTable` 中一行一个会话，`key like 'session:%'`，`value` 为 JSON 字符串。
- 代表记录（`value` 反序列化后的实际读取字段）：

```json
{"conversationId":"<会话id>","title":"重构路由","cwd":"D:\\work\\demo","status":"active","createdAt":"2026-10-21T10:50:09.000Z","updatedAt":"2026-10-21T11:20:00.000Z"}
```

- 只读取 `conversationId`、`title`、`cwd`、`status`、`createdAt`、`updatedAt`；其它字段未使用，完整 schema **待核实**。

## 如何还原成对话

1. 只读打开库，执行 `select key, value from ItemTable where key like 'session:%'`；打不开时返回一条 `unavailable` 记录（`sessionId: 'vscdb'`）。
2. 逐行 `JSON.parse(value)`，坏 JSON 跳过。
3. `sessionId` = `value.conversationId`，缺失时取 `key` 去掉 `session:`。
4. 时间：`createdAt`/`updatedAt` 先 `Date.parse`，失败再 `Number(...)`（epoch 毫秒）。
5. **无法还原成 user/assistant/thinking/tool 事件**：`timelineVscdb` 按 `session:<id>` 回读元信息后返回 `events: []`、`unavailable: true` 与注释“正文保存在 IDE 内部存储中，无法只读解析”。没有工具名可提取。
6. 若需要对话原文，只能到 Trae 自身 UI 查看；或用自定义适配器指向 Trae 导出的会话文件（是否存在此类导出 **待核实**）。

## 状态判定

不走 `judgeStatus`，按 `status` 文本正则：

- `complete|done|finished` → `completed`
- `run|active|progress` → `running`
- `wait|pending|input` → `waiting`
- 其它/缺失 → 默认 `completed`

`statusReason` 为 `IDE 会话状态：<原始 status>（正文存于 IDE 内部存储，H5 只读元信息）`。活跃时长：墙钟（`updatedAt - createdAt`）≤ 15 分钟时用墙钟，否则记 0（未知）。

**人工判断**：以 `value.status` 为准；库文件 mtime 在 2 分钟内**不会**被判定为进行中（vscdb 不用 mtime 规则）。若 status 缺失，只能按“有结束时间即视为完成”的默认口径理解。

## 坑与注意

- 只有元信息：消息数、工具调用数恒为 0，待办为空，没有最后消息预览。
- 规格说 `ItemTable` 的键可能含 `recentWorkspaces` / `chat` / `conversation`，但代码**只匹配 `session:%`**；若 Trae 改版换了键前缀，会枚举出 0 个会话 → 需要改适配器或自定义适配器（不要把 `chat`/`conversation` 键直接当会话读，结构未约定，**待核实**）。
- `%APPDATA%` 与 `%LOCALAPPDATA%` 两个候选路径只探测第一个存在的；两处都有库时不会合并。
- 共享库体积按会话数平摊计入任务存储，不是单会话真实占用。
- 只读打开；WAL 模式下若 `-wal`/`-shm` 不可读会降级 `unavailable`，不要写库、不要 checkpoint。
- 坏 JSON 行被静默跳过，会话数会少于库里键数——这是容错设计，不是数据丢失。

## 引用方式

```
%APPDATA%\Trae\User\globalStorage\state.vscdb   # 会话 id 记作 <库路径>#session=<id>
```

给编码 agent 的指令：这是 Trae 的 VS Code 同构 SQLite 会话库（`ItemTable`，`key like 'session:%'`，`value` 为 JSON）。请只读打开，解析每条 `value` 的 `conversationId/title/cwd/status/createdAt/updatedAt`，按 `createdAt` 排序。该库仅有元信息，**没有消息正文**；不要编造对话，需要正文时明确说明“正文在 IDE 内部存储中不可读”。不要写库。