---
status: accepted
---

# Board 是全局单一的 JSON 快照

Board 全局只有一个，Issue 以 `workspace` 作为属性与筛选维度，而非按 Workspace 切分成多个 Board。持久化采用**单个 JSON 快照**，以同目录临时文件 + fsync + 原子发布写入，并以 no-clobber 语义处理并发创建。

全局单一 Board 契合单 Operator 的处境：「今天该推哪个项目」本身就是要决策的事，跨项目的统一待办视角正是产品价值所在；同时省掉 N 个 Board 文件的生命周期管理。

## Considered Options

- **每个 Workspace 一个独立 Board** — 拒绝。切断了跨项目视角，且带来多文件生命周期管理。
- **JSONL 追加事件日志 + 内存投影** — 拒绝。这是 DSH 内部的主流做法（session-persistence-jsonl），因此**这里的偏离是刻意的**：按 ADR-0003，执行日志与 Token 已经住在 DSH 会话里，Vela 唯一要存的是 Issue 的当前状态与排序——一份小型可变文档。事件日志的确定性重放能力在这个规模上换不到收益，却牺牲了可读性与手工修改能力。
- **SQLite** — 拒绝。为几百到几千条记录引入二进制介质，失去 `git diff` 与手改能力。

## Consequences

存储路径必须显式配置，不得回落到 `process.cwd()`。同一份快照的读改写必须串行化。JSON 可读可手改可 diff 是刻意换来的收益；代价是放弃了「谁在何时把卡片拖到哪一列」的审计历史——若日后需要审计，追加一条独立的 JSONL 审计流，而不是把快照改成事件日志。
