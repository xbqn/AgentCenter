# zcode · zcode 会话解析规则

> 适配器 id `zcode`｜显示名 zcode｜存储形态 `JSONL`｜解析家族 `claude-jsonl`
> 依据：`core/adapters.mjs`、`core/parse.mjs`（`extractClaude`）、`core/util.mjs`、`docs/Agent适配器规格.md` §4

## 一句话用途

zcode 是桌面/命令行编码 Agent，适配器按 **Claude Code 同源 JSONL** 解析它的会话：每行一个带 `type` 的 JSON 记录，用户/助手消息在 `message.content[]` 里，工具调用与结果也是内容块。

## 存储位置

| 平台 | 默认路径 |
|---|---|
| Windows | `~\.zcode\sessions`、`%APPDATA%\zcode` |
| macOS | `~/.zcode/sessions` |
| Linux | `~/.zcode/sessions` |

- `~` 展开为 `%USERPROFILE%`（Windows）或 `$HOME`（macOS/Linux）；`%APPDATA%` 展开为 `C:\Users\<用户>\AppData\Roaming`。
- 首选 `~/.zcode/sessions`，Windows 另备选 `%APPDATA%\zcode`；探测取第一个存在的路径。
- 枚举：**递归遍历**根路径下所有 `.jsonl` 文件，上限 4000；`sessionId` = 文件名去掉 `.jsonl`，`slug` = 上级目录名。若根路径本身是文件而非目录，`walkFiles` 的 `readdir` 会失败并返回空 → 读不到会话。
- 未声明 `base`，适配器根目录就是探测到的路径本身；未声明中间文件目录（`intermediates: []`）。

## 文件格式

- 纯文本 JSONL，UTF-8；读时去 BOM、按 `\r?\n` 切分、跳空行、逐行 `JSON.parse`，坏行计数不抛出。
- 会话边界：**一个文件一个会话**；目录布局在规格中记为“推测与 CodeBuddy/AtomCode 同源，需实机校准”。
- 解析代码按 Claude 形态读取，因此**预期**代表记录如下（字段名即解析代码实际读取的字段）：

```json
{"type":"user","sessionId":"<uuid>","cwd":"D:\\work\\demo","timestamp":"2026-10-21T10:50:09.123Z","message":{"role":"user","content":[{"type":"text","text":"检查 start.bat"}]}}
{"type":"assistant","timestamp":"2026-10-21T10:50:12.000Z","message":{"content":[{"type":"thinking","thinking":"先看文件"},{"type":"text","text":"我来检查。"},{"type":"tool_use","name":"Read","input":{"file_path":"start.bat"}}]}}
{"type":"user","timestamp":"2026-10-21T10:50:13.000Z","message":{"content":[{"type":"tool_result","is_error":false,"content":[{"type":"text","text":"…"}]}]}}
{"type":"summary","summary":"修复启动脚本"}
```

- 本机未安装 zcode，工程内没有真实样本；除上述“解析器读取的字段”外，文件是否存在额外行类型、`timestamp` 是 ISO 还是数字 **待核实**。

## 如何还原成对话

1. 逐行读（单会话上限 6000 行），坏行跳过。
2. `type === "user" || "assistant"` → 取 `message.content`：字符串直接作正文；数组里 `text`→正文、`thinking`→思考、`tool_use`→工具调用（`name`/`input`）、`tool_result`→仅用于 `is_error` 失败判定。
3. 用户行正文为空 → 丢弃（工具结果回传与注入上下文都在 `user` 行里）；正文命中 `A goal has been set.` / `Continue working toward the active thread goal` / `Continue working on` / `The user has set a goal` / `[SYSTEM]` / `<goal>` / `<system>` 开头（忽略大小写）也丢弃。
4. `response_item` / `event_msg` → 按 `payload.role` / `payload.content[]` / `payload.message` 取；`summary` → 助手消息（回放时作为标题）；其它未知 `type` 忽略。
5. 时间：`timestamp` 数字直接用，字符串 `Date.parse`。`cwd`/`sessionId` 取行内字段。输出 `{role,time,text,tool}`，工具名取 `tool_use.name`。

## 状态判定

走 `judgeStatus`：文件 mtime 2 分钟内 → `running`；有 `is_error` 且最后一条真实消息不是助手 → `interrupted`；最后一条真实消息是用户 → `waiting`；助手末尾命中 `请确认|需要你|是否继续|等待你|请提供|要我继续` → `waiting`；否则 `completed`；无时间 → `pending`。无心跳来源（`heartbeatMs` 为 0）。用户消息间隔 > 30 分钟切段，只有最后一段可判进行中。

**人工判断**：看最后一条有正文的 `user`/`assistant` 记录；`tool_result` 行与 `summary` 行都不代表对话结束。文件 2 分钟内被写过即视为进行中。

## 坑与注意

- 本机无样本，**行格式未经实测**：若 zcode 实际使用 `role`/`content` 而不是 `type`/`message.content`，`extractClaude` 将解析出 0 条消息 → 不产出任务。接入时先用一个小文件核对，再决定是否补自定义适配器。
- 枚举是递归的：`%APPDATA%\zcode` 下若混有日志/配置里的 `.jsonl`，会被误当成会话；按 `slug` 与文件大小过滤。
- 工具结果回传在 `user` 行且无正文，必须剔除，否则首条用户消息被淹没。
- `~/.zcode/history.jsonl` 之类的扁平提问历史不在枚举规则内（适配器未把单文件当会话）；如果目录里混有它，会按同一解析器读出 0 条消息 → 不产出任务，结构本身 **待核实**。
- 单会话读取上限 6000 行，实现取文件**前** 6000 行（注释写“取尾部”，不一致）→ 待核实设计意图。
- 坏行 > 50% 时整会话报错；非 UTF-8 行会变成替换字符并计入坏行。
- 只读：不要改写任何 `.jsonl`。

## 引用方式

```
~/.zcode/sessions/<slug>/<sessionId>.jsonl
```

给编码 agent 的指令：这是 zcode 的会话文件，适配器按 Claude Code 同源 JSONL 解析。逐行 `JSON.parse` 后按 `timestamp` 排序，把 `type:"user"/"assistant"` 的 `message.content[]` 还原成 `{role,time,text,tool}`（`text`/`thinking`/`tool_use`/`tool_result`）；正文为空的用户行与自动续跑提示行丢弃，`summary` 作为标题，未知 `type` 忽略。若文件里没有 `type`/`message` 字段，请先报告实际结构而不是猜测。只读，不改写。