# doubao · 豆包工作台会话解析规则

> 适配器 id `doubao`｜显示名 豆包工作台｜存储形态 `Electron 存储`｜解析家族 `electron`
> 依据：`core/adapters.mjs`、`core/parse.mjs`（`electron` 分支）、`docs/Agent适配器规格.md` §10

## 一句话用途

豆包工作台是 Electron 桌面应用，数据按 Chromium 的目录结构存放（`Local Storage` 的 LevelDB、`Partitions` 下的站点存储、`blob_storage` 附件缓存）。适配器目前**不解析会话内容**，只把一个应用目录当作一条“目录占用”汇总。

## 存储位置

| 平台 | 默认路径 |
|---|---|
| Windows | `%APPDATA%\Bytedance\Doubao`（首选）、`%APPDATA%\Doubao`、`%LOCALAPPDATA%\Doubao` |
| macOS | `~/Library/Application Support/Bytedance/Doubao` |
| Linux | `~/.config/Bytedance/Doubao` |

- `%APPDATA%` = `C:\Users\<用户>\AppData\Roaming`；`%LOCALAPPDATA%` = `C:\Users\<用户>\AppData\Local`；`~` = `%USERPROFILE%` / `$HOME`。
- 探测取第一个存在的路径；未声明 `base`，适配器根目录就是探测到的目录本身。
- 中间文件目录（只统计）：`blob_storage`（附件缓存）。
- 命名：**没有会话文件名**——目录下的 Chromium 存储（`Local Storage/leveldb`、`Partitions/…`、`IndexedDB` 等）是应用内部格式；会话 id 记为目录名。

## 文件格式

- 形态：Electron/Chromium 目录树。会话正文（若有）位于 `Local Storage` 的 LevelDB 或 `Partitions` 下的站点存储；附件缓存位于 `blob_storage`。**这些都不是 JSONL、不是明文 JSON**。
- 会话边界：代码层面把整个目录当作**一个**汇总会话（`sessionId` = 目录名，`sourceFile` = 目录路径，`bytes` 记 0，另有 `electron: true`）。目录内的真实会话是否有独立边界，代码未实现 → **待核实**。
- 代表记录：不存在可解析的记录。代码只做 `dirBytes(root)` 统计目录占用；`listSessions` 对 electron 家族返回：

```json
{"sessionId":"Doubao","sourceFile":"<应用目录>","slug":"Doubao","cwd":"","mtimeMs":0,"bytes":0,"electron":true}
```

## 如何还原成对话

**做不到（按现有适配器）**：`parseSession` 命中 `electron` 家族时直接 `return []`，不产出任何任务，因此没有 user/assistant/thinking/tool 的映射，也没有工具名可提取。

若要手工还原，只能作为研究任务处理（代码未提供任何实现，以下为线索而非规格）：

1. 在应用目录的 `Local Storage/leveldb` 或 `Partitions/<partition>/Local Storage/leveldb` 中找 LevelDB `.ldb`/`.log` 文件。
2. 需要 Chromium LevelDB 读取器（如 LevelDB 兼容库）才能读出键值；键名与值格式随应用版本变化，**代码未约定**。
3. 读出的文本可能包含会话 JSON，但也可能只是 UI 状态；不要假设一定存在完整对话 → **待核实**。

## 状态判定

- 不产出任务 → **没有** 已完成 / 进行中 / 中断 的判定。
- 代码层面只有 Agent 级汇总（`installed` / `sessions: 1` / `bytes` / `tasks: 0`）。
- `judgeStatus` 的 mtime 2 分钟规则、工具失败规则对该 Agent 都不适用。
- **人工判断**：只能看应用目录的 mtime 与体积变化，推断“最近是否在用”；这不能证明某个会话的状态，**不要**把它写成任务状态。

## 坑与注意

- 这是“目录统计”而非“会话解析”：索引里该 Agent 的 `tasks` 恒为 0，不要误以为扫描失败。
- LevelDB 文件在应用运行时可能被锁；只读复制副本再读更安全（原目录仍不可写）。
- `blob_storage` 是附件二进制，读不出对话文本；只计入可回收空间。
- 规格实测“本机 `%APPDATA%\Bytedance` 下仅有 `JianyingPro`（剪映），豆包本体未装”，因此路径是否命中需实机确认。
- 未声明 `base`，中间文件路径相对探测到的根目录计算；换路径后需重扫。
- 非 UTF-8 / 二进制内容不要按文本读，会产生乱码与无效 JSON。
- 只读：不要删除、不要迁移应用目录。

## 引用方式

```
%APPDATA%\Bytedance\Doubao
```

给编码 agent 的指令：这是豆包工作台的 Electron 应用目录。当前 AgentCenter 只把它当作**目录占用**统计，不解析会话；目录内是 Chromium 的 LevelDB/IndexedDB 存储，不是 JSONL。若要研究其中的对话，请先只读复制一份到临时目录，再尝试读取 `Local Storage`/`Partitions` 下的 LevelDB 键值，并明确报告读到的是 UI 状态还是会话正文；不要修改原目录，也不要把“目录存在”当成“有可读会话”。