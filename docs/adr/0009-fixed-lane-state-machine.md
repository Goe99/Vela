---
status: accepted
---

# Lane 集合固定为六个，与状态机一一对应

Board 的 Lane 不可配置，固定为 **Backlog / Todo / Running / 待验收 / Done / Failed**，每个 Lane 恰好是 Issue 状态机的一个节点。

Lane 在 Vela 里不是标签而是状态机节点：Running 由 Run 的启动与结束驱动，待验收由 ADR-0007 的交付事件驱动，两者都不由 Operator 直接拖入。开放 Lane 配置会让 Operator 造出状态机无法到达、或进入后无法离开的死 Lane，而这类缺陷在拖拽界面上极难自查。

## Considered Options

- **可配置 Lane（Multica 的 status 枚举那套）** — 拒绝。Multica 需要它是因为要服务多个团队各有流程；Vela 只有一个 Operator（ADR-0001），可配置带来的是状态机可推理性的净损失。

## Consequences

Issue 的 status 是一个封闭联合类型，而非自由字符串。新增 Lane 属于改状态机，需要同时定义其进入与离开的迁移条件，并回到本 ADR 更新。拖拽只能在状态机允许的迁移之间进行——UI 必须拒绝非法落点，而不是接受后再回滚。
