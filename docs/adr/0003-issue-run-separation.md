---
status: accepted
---

# Issue 与 Run 分离，Issue 不等于 DSH 会话

一张 Board 卡片必须在被指派之前就存在（backlog），并且在被重试三次之后依然是同一张卡片。DSH 的会话不具备这两个性质：会话一旦创建即是活的，且每次重试都是一个新会话。因此 Vela 采用两层模型——**Issue 是独立实体，持有零到多个 Run，每个 Run 绑定一个 DSH 会话**。

## Considered Options

- **Issue == 一个 DSH 会话** — 拒绝。模型最省，但无法表达未指派的 backlog，且一次重试就会分裂出第二个身份。
- **Issue == 一个 subagent job** — 拒绝。job 绑死在父会话的生命周期上，父会话结束卡片即消失，而 Board 必须长驻。

## Consequences

`Run → SessionId` 是一条外键，这带来一个关键收益：**执行日志与 Token 用量不需要 Vela 自己存储**，DSH 的会话事件日志本身就是 Run 的权威记录。Vela 只拥有 Issue 的状态机与排序，执行侧的真相始终留在 DSH 里，避免了双写与不一致。

代价是多一层映射：Board 上任何要展示执行态的地方，都需要经由 Run 解析到 SessionId 再读取会话事实。
