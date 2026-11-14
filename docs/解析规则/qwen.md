# qwen · 千问工作台会话解析规则

> 适配器 id `qwen`｜显示名 千问工作台｜存储形态 `Electron 存储`｜解析家族 `electron`
> 依据：`core/adapters.mjs`、`core/parse.mjs`（`electron` 分支）、`docs/Agent适配器规格.md` §11

## 一句话用途

千问工作台是 Electron 桌面应用，数据是 Chromium 目录树（`Local Storage`、`Partitions`、`blob_storage` 等）。适配器目前**不解析会话内容**，只把一个应用目录当作一条“目录占用”汇总。

## 存储位置

| 平台 | 默认路径 |
|---|---|
| Windows | `%APPDATA%\Tongyi`（首选）、`%APPDATA%\Tongyi\Qianwen` |
| macOS | `~/Library/Application Support/Tongyi` |
| Linux | `~/.config/Tongyi` |

- `%APPDATA%` = `C:\Users\<用户>\AppData\Roaming`；`~` = `%USERPROFILE%` / `$HOME`。
- 探测取第一个存在的路径；未声明 `base`，适配器根目录就是探测到的目录本身。
- 中间文件目录（只统计）：`blob_storage`（附件缓存）、`Local Storage`（站点存储）、`Partitions`（分区存储）。
- 命名：**没有会话文件名**；会话 id 记为目录名（如 `Tongyi`），`sourceFile` 是目录路径。

## 文件格式

- 形态：Electron/Chromium 目录树，不是 JSONL、不是单个数据库文件。会话（若有）在 `Local Storage` 的 LevelDB 或 `Partitions/<partition>` 的站点存储里；附件在 `blob_storage`。
- 会话边界：代码把整个目录当作**一个**汇总会话（`sessionId` = 目录名，`sourceFile` = 目录路径，`bytes` 记 0，`electron: true`）。真实会话粒度未实现 → **待核实**。
- 代表记录：不存在可解析记录。`listSessions` 对 electron 家族只返回：

```json
{"sessionId":"Tongyi","sourceFile":"<应用目录>","slug":"Tongyi","cwd":"","mtimeMs":0,"bytes":0,"electron":true}
```

- 目录体积由 `dirBytes(root, { maxFiles: 200000 })` 递归统计（排除符号链接）。

## 如何还原成对话

**做不到（按现有适配器）**：`parseSession` 命中 `electron` 家族直接 `return []`，不产出任务；没有 user/assistant/thinking/tool 映射，也没有工具名。

手工研究路径（代码未实现，仅为线索）：

1. 只读复制 `Local Storage` 或 `Partitions/<partition>` 下的 LevelDB 文件；应用运行时可能锁文件。
2. 用 Chromium LevelDB 读取器读键值；键名与值格式随版本变化，未在代码中约定。
3. 读出的内容可能是会话 JSON，也可能只是 UI 状态或缓存 → 必须核对，不能假设可还原完整对话，**待核实**。

## 状态判定

- 不产出任务 → 没有已完成 / 进行中 / 中断 的判定；`judgeStatus` 全部不适用。
- Agent 级只有 `installed` / `sessions: 1` / `bytes` / `tasks: 0`。
- **人工判断**：只能看目录 mtime 与体积变化推断“最近是否在用”，不能作为某个会话的状态依据。

## 坑与注意

- 目录统计不等于会话解析：该 Agent 的 `tasks` 恒为 0，属预期行为。
- 规格实测“目录存在，当前仅 `logs` 子目录”，说明可能根本没有会话数据；`logs` 可用于推断活跃时间，但适配器不读。
- `Local Storage` / `Partitions` 同时被列为中间文件目录，会重复计入“可回收空间”与 Agent 根目录总占用（两者口径不同，别相加）。
- LevelDB 读取需处理 `CURRENT`/`MANIFEST`/`.ldb`/`.log`，且可能遇到 WAL 尾部截断；不要就地修复应用目录。
- 非 UTF-8 二进制不要按文本读。
- 未声明 `base`，中间文件相对探测根目录计算，换路径后需重扫。
- 只读：不删除、不迁移应用目录。

## 引用方式

```
%APPDATA%\Tongyi
```

给编码 agent 的指令：这是千问工作台的 Electron 应用目录。当前 AgentCenter 只做目录占用统计，不解析会话；目录内是 Chromium 的 LevelDB / IndexedDB 存储，不是 JSONL。若要研究其中的对话，请先把 `Local Storage` 或 `Partitions` 下的 LevelDB 只读复制到临时目录再读取，并报告读到的是 UI 状态还是会话正文；不要修改原目录，也不要把“目录存在”当成“有可读会话”。