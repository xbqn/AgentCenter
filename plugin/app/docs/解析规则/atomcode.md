# atomcode · AtomCode 会话解析规则

> 适配器 id `atomcode`｜显示名 AtomCode｜存储形态 `JSONL`｜解析家族 `atomcode`
> 依据：`core/adapters.mjs`、`core/parse.mjs`（`extractAtomcode`）、`core/util.mjs`、`docs/Agent适配器规格.md` §6

## 一句话用途

AtomCode 把会话按 `<hash>/<uuid>.jsonl` 存放在 `~/.atomcode/sessions` 下，每个文件是“用户 + 助手 + 工具”三种字段混排的 JSONL：一行里可能带 `user`、`assistant` 或 `tools`，而不是 `role`/`content` 结构。

## 存储位置

| 平台 | 默认路径 |
|---|---|
| Windows | `~\.atomcode\sessions` |
| macOS | `~/.atomcode/sessions` |
| Linux | `~/.atomcode/sessions` |

- `~` 展开为 `%USERPROFILE%`（Windows）或 `$HOME`（macOS/Linux）；适配器根目录为 `~/.atomcode`。
- 布局：`~/.atomcode/sessions/<hash>/<sessionId>.jsonl`；枚举**只下沉一层**：hash 目录里直接以 `.jsonl` 结尾的文件，**跳过 0 字节文件**（空会话不计任务），上限 4000。
- 同目录旁路文件：`.events`、`.index`、`.lease`、`.rewind`、`.meta.lock`（代码不读，规格提到可用 `.index` 加速）。
- 中间文件目录（只统计）：`file-history`、`image-cache`、`datalog`、`staged`；另有 `~/.atomcode/history.json`（全局提问历史）。

## 文件格式

- 纯文本 JSONL，UTF-8；读时去 BOM、按 `\r?\n` 切分、跳空行、逐行 `JSON.parse`，坏行计数。
- 会话边界：**一个文件一个会话**；`sessionId` = 文件名去掉 `.jsonl`，`slug` = hash 目录名（该目录名不能还原为真实路径）。
- 代表记录（字段名取自解析代码）：

```json
{"user":"检查 start.bat","ts":1792551022000,"cwd":"D:\\work\\demo"}
{"assistant":"我来检查。","ts":1792551025000}
{"tools":[{"name":"Read","arguments":"{\"path\":\"start.bat\"}"},{"name":"Edit","error":true}],"ts":1792551026000}
{"user":"补一个测试","iso":"2026-10-21T10:50:09.000Z"}
```

- 时间：优先 `ts`（epoch 毫秒），否则 `iso` 字符串经 `Date.parse`；`cwd` 取行内 `cwd`（后出现的覆盖）。

## 如何还原成对话

1. 逐行读（单会话上限 6000 行），坏行跳过。
2. 每行独立判断，不要求 `type`：
   - 有 `j.user` → 一条用户消息，正文即该字符串。
   - 有 `j.assistant` → 一条助手消息，正文即该字符串。
   - `j.tools` 为数组 → 每个元素一条工具事件；工具名取 `tl.name` 或 `tl.tool`，都没有时用字面量 `tool`；`tl.error` 为真则标记失败。
   - `j.tools` 是对象（非数组）→ 记一条工具事件，名字用 `tool`，失败标记为假。
   - 一行可同时命中多种字段（例如既有 `user` 又有 `tools`），按上述顺序全部展开；都不命中的行忽略。
3. 工具调用参数：`extractAtomcode` 只取名字与 `error`，**不取参数**；回放层 `timelineJsonl` 才读 `tl.arguments` 拼进事件文本。
4. 输出 `{role,time,text,tool}`：`user` / `assistant` / `tool`；工具事件 `tool` 字段填工具名。

## 状态判定

走 `judgeStatus`：文件 mtime 2 分钟内 → `running`；工具失败且最后一条真实消息不是助手 → `interrupted`；最后一条真实消息是用户 → `waiting`；助手末尾命中 `请确认|需要你|是否继续|等待你|请提供|要我继续` → `waiting`；否则 `completed`；无时间 → `pending`。AtomCode 不提供心跳（`heartbeatMs` 恒为 0）。用户消息时间间隔 > 30 分钟切段，只有最后一段可能判进行中。

**人工判断**：看最后一行命中哪类字段——`user` 结尾即等待，`assistant` 结尾且无 `error` 即完成；`tools` 里出现 `error:true` 且其后无助手行即中断。0 字节文件说明会话未写入内容。

## 坑与注意

- 不是标准的 `role`/`content` 结构：一行可能同时含用户文本与工具数组，按“字段存在即展开”处理，不要按 `type` 分派。
- `tools` 既可能是数组也可能是对象，两种形态都出现过；对象形态拿不到工具名，只能用 `tool` 占位。
- `ts` 缺失时才退回 `iso`；两者都缺的行时间为 0，会拉低起止时间与活跃时长（活跃时长只累计相邻间隔 ≤ 5 分钟的部分）。
- 枚举跳过 0 字节 `.jsonl`，但 **不跳过** 只有旁路文件没有主文件的目录。
- 同目录 `.index`/`.events`/`.rewind` 不是会话正文，不要当 JSONL 读。
- 规格提到 `~/.atomcode/history.json` 的结构 `[{"role":"User","content":{"Text":...}}]`，但适配器只登记了 `sessions` 路径，`history.json` 未被解析 → 待核实是否需要覆盖。
- 单会话读取上限 6000 行，实现取文件**前** 6000 行（注释写“取尾部”，不一致）→ 长会话可能缺最新内容，待核实设计意图。
- 坏行 > 50% 时整会话报错；只读，不要改写源文件。

## 引用方式

```
~/.atomcode/sessions/<hash>/<sessionId>.jsonl
```

给编码 agent 的指令：这是 AtomCode 的会话 JSONL，结构不是标准的 role/content。逐行解析后按 `ts`（无则 `iso`）排序，把 `user`/`assistant` 字符串分别还原为用户与助手消息，`tools` 数组（或对象）还原为工具事件（名字取 `name`/`tool`，`error` 标记失败）；一行可展开多条事件；无法识别的行忽略。输出 `{role,time,text,tool}`。只读该文件，不改写。