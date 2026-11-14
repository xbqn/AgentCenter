# data/ — 本机索引产物（不入库）

这里的文件都由本机只读扫描生成或由用户在本机操作生成，**含本机绝对路径与真实会话内容**，
所以 `.gitignore` 把它们全部排除，仓库里只保留这份说明。

| 文件 / 目录 | 来源 | 可否重建 |
|---|---|---|
| `summary.json` | `node cli/agentcenter.mjs scan` | 可重建（重新扫描即可） |
| `index.json` | 同上 | 可重建 |
| `fingerprints.json` | 同上（增量扫描用的 `mtime + size` 指纹） | 可重建 |
| `scans.json` | 同上（每轮扫描写一条，保留最近 50 条） | 可重建 |
| `config.json` | 「监控对象 / 扫描调度」页面的配置写入 | **不可重建**，换机请自己备份 |
| `overrides.json` | 「标记完成」写入的人工判定 | **不可重建**，换机请自己备份 |
| `links.json` | DeepSeek Harness 插件写入的「任务 → 会话」关联 | **不可重建** |
| `日报/YYYY-MM-DD.md` | `node cli/agentcenter.mjs report` 或日报页生成 | 可由索引重新生成（同一天幂等覆盖） |

换一台机器上手：

```bat
node cli\agentcenter.mjs scan     :: 生成 summary / index / fingerprints / scans
h5\start-h5.cmd                    :: 起本地服务看页面
```