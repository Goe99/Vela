---
status: accepted
---

# 每个 Run 是插件创建的顶层会话

> **机制修正（见 ADR-0015）**：本 ADR 原文写的是经 `ctx.sessions.create()` 创建。实际实现改为经宿主的 `ctx.apiProxy.sessions.create()`——因为第三方插件解析不到驱动 agent 所需的那几个 `@deepseek-ai` 运行时模块。**本 ADR 的结论不变且已实跑验证**：Run 确实是一个顶层会话，不是 subagent 子会话。文末标注的「尚未取证」也已关闭。

Run 创建为**顶层 DSH 会话**，而非 subagent 子会话。本 ADR 修正 ADR-0004 的执行机制（该 ADR 的决策方向不变，见其修正说明）。

起因是一次取证结果推翻了原假设：`subagents.start()` 的请求体**强制要求 `parent`**——Provider 实现中子会话 id 直接由 `request.parent.id` 派生，`tool-subagent` 传入的是 `owner: parent`。subagent 框架是严格的父子结构，每个子 Run 都必须挂在一个已存在的会话之下。而 Operator 在 Board 上点击派活时并不存在父会话。`SessionHeader` 中 `meta.parentSession` 是可选字段、`origin: 'subagent'` 仅是子会话的分类标记，可见顶层会话是一等公民。

## Considered Options

- **维持一个隐藏的 dispatcher 父会话，所有 Run 作为其 subagent** — 拒绝。为迁就一个错误机制引入结构性别扭：会话列表里多出一个语义可疑的常驻会话，且子会话带 `origin: 'subagent'` 标记后可能不进主列表，Operator 反而看不到自己派出去的活。
- **派活挂到 Operator 当前所在的会话** — 拒绝。直接破坏 Board 的跨会话全局性，与 ADR-0002 的立足点冲突。

## Consequences

这个修正**加强**了 ADR-0003：`Run → SessionId` 指向一个真实的顶层会话，Operator 可以像点开任何会话那样进去看 Agent 在干什么——这正是 ADR-0002 已定的交互（点 Run → `sessions.open()`）。

Run 会出现在 sidebar 的会话列表中，与 Operator 手动开的会话混排。若日后需要区分，应通过会话元数据标记而非另造一套列表。

**已取证并实跑验证**：驱动一次 Run 跑完的完整路径见 ADR-0015。一次真实派活已确认：Agent 在自己的顶层会话里完成了任务（在指定工作目录里真的建出了文件），Issue 自动流到待验收而**不是** done，token 用量也正确快照入 Run。
