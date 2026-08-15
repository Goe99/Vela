---
status: accepted
---

# Issue 只由 Operator 创建，Agent 不写 Board

Issue 有两个创建入口，都归 Operator：**手动新建**，以及**从当前会话一键提取**（与 Agent 聊出一批待办后落到 Board）。Agent 没有任何写入 Board 的能力——Vela 不为此注册工具。

## 为什么拒绝「让 Agent 自己拆子 Issue 回写 Board」

这个方案很有吸引力，也几乎肯定会被再次提出，因此记录拒绝理由：

- **它会绕过 ADR-0007 刚建立的把关点。** Agent 一旦能写 Board，就能给自己派活、推动自己的卡片流转，Operator 的验收权被架空。「Agent 有权交付、无权宣布通过」这条规矩会从状态机层面被掏空。
- **它与 ADR-0006 的存储形态冲突。** Board 是单个 JSON 快照；放开 Agent 并发写入需要额外的串行化与冲突策略，而并发写入方恰恰是最不可预测的一方。

## Consequences

插件在 host 面**不注册任何工具**（`ctx.tools.register` 不出现），这显著缩小了运行面与攻击面。

若日后要开放此能力，前置条件是先明确两条边界：Agent 创建的 Issue 只能进入 Backlog Lane，且不得自行发起 Run。在这两条边界写进状态机之前不实现。
