---
status: accepted
---

# 派活经宿主的 apiProxy 服务，不 import 任何 dsh 运行时模块

Vela 通过 **`ctx.apiProxy.sessions`** 完成派活的全部动作：`create` 建会话及其空闲 agent、`rename` 给会话起名、`prompt` 提交任务、`cancel` 停止执行；执行的进展与结束经 Cordis 的 `session/event` 事件观察。全程**不 import 任何 `@deepseek-ai/*` 运行时模块**。

本 ADR 修正 ADR-0013 的机制（该 ADR 的结论「Run 是一个顶层会话」仍然成立，且已实跑验证），并关掉它标注的「`sessions.create()` 之后由谁驱动 agent loop」这个缺口。

## 为什么不照 headless 那条路写

官方 `dsh-headless` 包演示了标准执行序列：`ctx.agents.create()` → `whenIdle()` → `followup(createUserMessage(...))` → `whenIdle()` → `sessions.flush()`。它需要三个值导入——`createUserMessage`、`SessionId`、`installModelSelection`。

**第三方插件解析不到这些包。** 实际运行时的 `@deepseek-ai/dsh-*` 是捆绑在全局 `@deepseek-ai/dsh` 安装内的 `0.1.0-rc.6`；npm 上独立发布的那条线是陈旧的 `0.0.1-rc.1`。从 Vela 自己的目录做 Node 解析既找不到前者，声明后者又会引入第二份 runtime identity。

可以照抄那几个函数的实现（`SessionId` 是恒等函数，`createUserMessage` 只是加 id 再深冻结）。**拒绝这么做**：那是把官方的内部数据结构复制成一份平行契约，上游改形状时会静默失效——正是「不要把某个项目的偶然实现当成框架契约」这条戒律针对的情形。

## 为什么 apiProxy 是正确答案而不是权宜之计

`apiProxy` 的官方定义是「**传输无关的网关面**」：浏览器点「新会话」走的就是同一份实现，HTTP/WebSocket 只是物理通道。进程内直接调用它，得到的是官方开会话逻辑**本身**，而不是复制品——包括 cwd 冲突检查、preset 解析与挂载、workspace 附着、并发去重。

顺带解决了三件本来要自己做的事：会话标题（`rename` 让 Run 在侧栏可辨认）、模型选择的安装、以及 preset 组合。

## Consequences

Vela 的 host 面对 dsh 的全部依赖收敛为三个可选服务（`apiProxy`、`permissionPresets`、`sessions`）加一个事件（`session/event`），且都以结构化最小接口声明。这让 Vela 对 developer-preview 的版本漂移基本免疫，代价是编译器不再校验这些签名——每一条都必须对着真实运行时取证，改动时同样。

`apiProxy` 未挂载时 Board 仍完全可用（看板、建卡、排序、Gate 都不依赖它），只是派活按钮**不出现**——而不是给一个点了就报错的入口。因此它是可选 service 而非 `inject` 必需项：一个 pending fiber 对 Operator 是完全隐形的，比一条能读的错误消息糟得多。

结束判定来自 `turn/end` 事件而非 `whenIdle()`。这带来一个必须处理的边界：进程被杀时停在 running 的 Run 不会收到任何事件，因此启动时必须扫描并把它们结算为 interrupted，否则那些卡片永远停在 Running。
