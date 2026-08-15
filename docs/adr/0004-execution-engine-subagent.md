---
status: accepted
---

# 执行复用 DSH 自有设施，不自建 daemon

> **机制修正（见 ADR-0013）**：本 ADR 原文写的是「只使用 subagent 框架承载 Run」，该**机制已被取证推翻**——`subagents.start()` 强制要求 `parent`，而 Board 派活时不存在父会话。Run 现改为通过 `ctx.sessions.create()` 创建顶层会话。下文的**决策方向仍完全成立**：复用 DSH 自己的执行设施，不自建 daemon。

Multica 通过一个独立 daemon 进程 spawn 二十余种外部 agent CLI。Vela 不复制这条路线，而是**只使用 DSH 内置的执行设施**来承载 Run。沙箱、审批、事件日志、崩溃恢复全部随之继承。

自建 daemon 意味着重新实现进程管理、沙箱、日志采集与崩溃恢复——等于在 DSH 里重写一个 DSH，是这个项目最大的沉没成本陷阱。「统一管理多个 AI 代理」这条价值主张的重点在**统一管理**（派活、追踪、验收），不在**代理数量**。

## Consequences

v1 的 agent 覆盖面等于 DSH 的覆盖面。Vela 内部仍应把「启动一个 Run」收敛到一个窄接口后面，使日后接入其他执行器时无需改动 Board 与 Issue 状态机；但 v1 不实现第二个执行器。
