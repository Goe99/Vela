---
status: accepted
---

# Agent 有权交付，无权宣布通过

Run 成功结束时，Issue **自动推进到「待验收」**，但不进入终态；接受或退回由 Operator 在 Gate 上决定。这是「人工验收闸门」这条价值主张的落点，也是 Board 相对于手工登记簿的核心价值。

## Considered Options

- **Run 结果直接推到终态（done / failed）** — 拒绝。等于让 Agent 自己宣布验收通过，Operator 失去把关点，Board 退化成执行结果的被动镜子。
- **全手动，Run 结果只做展示** — 拒绝。Operator 要为每张卡片手工登记状态，Board 退化成登记簿，自动化收益归零。

## Consequences

Issue 状态机中「待验收」是一个由 Run 结果自动进入、只能由 Operator 离开的状态。Gate 的通过与退回是 Issue 状态迁移的唯一终态入口。Run 失败的走向（是否自动重试、进入哪个 Lane）由后续决策定义，不在本 ADR 范围内。
