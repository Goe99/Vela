# 08 — Gate：待验收、接受与退回

**What to build:** Agent 干完活后，卡片停在待验收而不是自己宣布完成。Operator 接受则进 Done，退回则回 Todo。这是 Board 相对于一块被动的状态镜子的核心差别。

**Blocked by:** 07 — 派活：Run 启动、Running Lane 与跳转会话

**Status:** done

- [x] Run 成功结束时 Issue 自动进入待验收 Lane，**不进入任何终态**
- [x] Operator 接受后 Issue 进入 Done
- [x] Operator 退回后 Issue 回到 Todo
- [x] 待验收是通往终态的唯一入口；Run 结果本身无法把 Issue 推进 Done
- [x] Gate **不阻塞** Agent：一个 Issue 停在待验收期间，其他 Run 可正常启动，也不占用任何会话或上下文
- [x] Gate **不**使用 DSH 的 `user-approval` 实现
- [x] 卡片显示该 Issue 已经历过多少次 Run
- [x] 状态机测试覆盖：Run 成功 → 待验收 → 接受 / 退回 的完整路径，以及绕过 Gate 直达终态的尝试被拒绝
