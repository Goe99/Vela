# Spec: Vela Board — 单 Operator 的 Agent 项目管理面板

> 状态：ready-for-agent
> 依据：ADR-0001 至 ADR-0013、[CONTEXT.md](../../CONTEXT.md) 术语表

## Problem Statement

Operator 在 dsh 里同时推进多个项目，同时开着多个会话。他今天要做的事散落在三处：脑子里、过往的聊天记录里、以及各个仓库的 TODO 注释里。

由此产生四个具体痛点：

- **看不到全局。** 哪些活正在跑、哪些等他验收、哪些还没派出去——没有任何一个地方能一眼看全。会话列表只按时间排，不表达状态。
- **派活成本高。** 每想派一个活，要先找对目录、开新会话、把上下文重新打一遍。这个摩擦大到让他倾向于「自己顺手做了」，Agent 因此被闲置。
- **验收要考古。** 活干完了，结果混在几百行对话里。要判断能不能收，得从头翻。
- **花了多少钱不知道。** 某件事烧了多少 token 无从查证，更无法比较「这件事值不值得让 Agent 干」。

## Solution

一个全幅 Board，从 sidebar 页脚一键打开，覆盖整个界面。所有 Issue 以卡片形式按状态分列在六个 Lane 上，跨 Workspace 统一呈现。

Operator 在卡片上一键派活：Vela 创建一个独立的顶层会话，Agent 在其中执行，卡片自动流转到 Running。Agent 干完后卡片自动进入「待验收」——但**不会**自己宣布通过；Operator 在 Gate 上接受或退回。

每张卡片显示 Run 历史、token 用量与失败原因，点任一 Run 即跳进那次执行的完整会话，Board 随之关闭。

## User Stories

### Board 的打开与几何

1. As an Operator, I want a navigation entry at the sidebar foot, so that I can open the Board from anywhere without abandoning my current session.
2. As an Operator, I want the entry to stay usable when the sidebar is collapsed, so that I don't have to expand the column just to reach the Board.
3. As an Operator, I want the Board to cover the whole frame when open, so that I can think about the project instead of squinting at a panel.
4. As an Operator, I want Escape to close the Board, so that I return to my work without hunting for a close button.
5. As an Operator, I want the Board to remember nothing about scroll position between opens, so that I always start from the top of my priorities.
6. As an Operator, I want the Board to work on a narrow window with an internal scroll, so that a small screen degrades gracefully instead of clipping.
7. As an Operator, I want keyboard focus trapped inside the open Board, so that Tab doesn't wander into the hidden app behind it.

### Issue 的创建与编辑

8. As an Operator, I want to create an Issue manually with a title, so that I can capture a task the moment I think of it.
9. As an Operator, I want to add a longer description to an Issue, so that the Agent later receives enough context to act.
10. As an Operator, I want to extract Issues from my current session in one action, so that a planning conversation with an Agent turns into Board cards without retyping.
11. As an Operator, I want to assign each Issue a Workspace, so that the Agent later runs in the right repository.
12. As an Operator, I want to set a priority on an Issue, so that the Board reflects what matters.
13. As an Operator, I want to edit an Issue's title and description after creation, so that a card sharpens as I learn more.
14. As an Operator, I want to delete an Issue, so that abandoned ideas don't accumulate.

### 排序与拖拽

15. As an Operator, I want to drag a card to reorder it within its Lane, so that the Lane top is literally what I do next.
16. As an Operator, I want to drag a card between Lanes, so that I can correct state the system got wrong or park something.
17. As an Operator, I want illegal drops rejected at drop time, so that I never see a card snap into a Lane and then bounce back.
18. As an Operator, I want reordering to survive a restart, so that the effort I spent prioritising isn't lost.
19. As an Operator, I want drag to work by keyboard, so that I can reorder without a mouse.

### 筛选与视图

20. As an Operator, I want the Board filtered to my current Workspace by default, so that a single project's work isn't drowned by the others.
21. As an Operator, I want to switch to an all-Workspace view, so that I can decide which project to push today.
22. As an Operator, I want each card to show its Workspace when viewing all, so that I can tell where a task lives at a glance.

### 派活与执行

23. As an Operator, I want to dispatch an Issue to an Agent with one click, so that the cost of delegating is near zero.
24. As an Operator, I want the card to move to Running automatically when the Run starts, so that the Board reflects reality without my help.
25. As an Operator, I want each Run to be an ordinary top-level session, so that I can open it exactly like any conversation I started myself.
26. As an Operator, I want clicking a Run to open its session and close the Board, so that the path from "what is it doing?" to "here's the transcript" is one click.
27. As an Operator, I want a per-Issue sandbox tier, so that editing a README and editing a build script don't get the same blast radius.
28. As an Operator, I want a per-Issue agent preset, so that a cheap task and a hard task can use different models.
29. As an Operator, I want a per-Issue timeout, so that a runaway task doesn't burn budget indefinitely.
30. As an Operator, I want sensible global defaults for all three, so that most cards need no configuration at all.
31. As an Operator, I want approval prompts during a Run to appear through dsh's normal channel, so that urgent sandbox decisions aren't buried in the Board.

### Gate（验收）

32. As an Operator, I want finished work to land in 待验收 rather than Done, so that nothing is declared complete without me.
33. As an Operator, I want to accept a Run's output and move the Issue to Done, so that closing the loop is deliberate.
34. As an Operator, I want to reject a Run's output and send the Issue back, so that unsatisfactory work re-enters the queue.
35. As an Operator, I want the Gate to never block the Agent, so that a card can wait hours for me without holding a session hostage.
36. As an Operator, I want to see how many Runs an Issue has already had, so that I can notice a task that keeps failing review.

### 可观测与失败处理

37. As an Operator, I want to see token usage per Run, so that I can judge whether delegating was worth it.
38. As an Operator, I want to see total token usage per Issue, so that I can spot the tasks that quietly cost the most.
39. As an Operator, I want live token usage while a Run is in flight, so that I can kill something that's clearly spiralling.
40. As an Operator, I want a failed Run to put the Issue in Failed with the failure reason visible, so that I can diagnose without opening the transcript.
41. As an Operator, I want to manually re-dispatch a failed Issue, so that a transient failure costs one click.
42. As an Operator, I want automatic retry to be off by default and opt-in per Issue, so that a deterministic failure doesn't silently burn three times the tokens.
43. As an Operator, I want usage to show as unknown rather than zero when a Run died abnormally, so that I'm not misled by a fake number.

### 持久化与可维护性

44. As an Operator, I want the Board to survive a dsh restart, so that it's a real system of record.
45. As an Operator, I want the Board stored as readable JSON at a path I configure, so that I can hand-edit it and put it under version control.
46. As an Operator, I want a crash mid-write to never leave a corrupt Board, so that I don't lose my planning to a power cut.

## Implementation Decisions

### 运行面与包契约

- **host + client 双面插件。** 持久化、HTTP、会话创建在 host；slot 注册、浮层、拖拽在 client。
- **host 面不注册任何工具。** Agent 无法写 Board（ADR-0012），`ctx.tools.register` 不出现，运行面与攻击面因此显著缩小。
- 包同时提供 `.` 与 `./client` 两个 export、`dsh.bundle.patch` 指向 `cordis.patch.yml`、`dsh.client.platform: "web"`。不开启 `dsh.client.immediately`。
- DSH / Cordis / React 声明为 peer，避免复制 runtime identity。
- `cordis.patch.yml` 为顶层数组，单个 `insert` 行，行 id 稳定。

### 依赖的 service

- host：`webServer`（路由注册）、`sessions`（创建 Run 会话、读取会话事实）。
- client：`slots`。
- 均为必需 inject；未满足时 fiber 保持 pending，不用轮询模拟。

### 领域模型

- **Issue 与 Run 分离**（ADR-0003）。Issue 独立存在，持有 0..n 个 Run，Run 通过 SessionId 指向一个真实的顶层会话。
- **Issue.status 是封闭联合类型**，恰好六个取值对应六个 Lane：Backlog、Todo、Running、待验收、Done、Failed（ADR-0009）。新增 Lane 属于改状态机。
- **排序用分数索引**（float 位置值，中点插入），避免拖拽时重排整列。
- Issue 持有可选的执行配置覆盖（agent preset、sandbox 档位、超时）与 `maxAttempts`（默认 0）。

### 状态机

- Run 启动 → Issue 进 Running（系统驱动）。
- Run 成功结束 → Issue 进「待验收」（系统驱动，**不进终态**，ADR-0007）。
- Gate 接受 → Done；Gate 退回 → 回到 Todo。**Gate 是进入终态的唯一入口。**
- Run 失败 → Issue 进 Failed；若 `maxAttempts > 0` 且未用尽则重新派活。
- Operator 拖拽只能走状态机允许的迁移；非法落点在 drop 时拒绝，不接受后回滚。

### 执行

- **每个 Run 是 `ctx.sessions.create()` 创建的顶层会话**（ADR-0013），不是 subagent 子会话——`subagents.start()` 强制要求 `parent`，而 Board 派活时无父会话。
- 「启动一个 Run」收敛到一个窄接口后面，接收一份已解析完成的执行配置（解析顺序：Issue 覆盖 → 全局默认），使日后换执行器不触动 Board 与状态机。
- Vela 不拦截、不包装、不改写 `user-approval`（ADR-0008）；执行期审批仍走 dsh 原生通道。

### 持久化

- **单个全局 JSON 快照**（ADR-0006），Issue 以 workspace 为属性而非分区。
- 写入用同目录临时文件 + fsync + 原子发布；并发创建用 `link()`+`unlink()` 的 no-clobber 协议，不用 `rename()` 静默覆盖。
- 同一份快照的读改写串行化。
- **路径由配置显式指定**，不回落 `process.cwd()`。
- 恢复与 HMR 不假设创建事件会重放；启动时显式加载现有快照。

### Token 用量

- Run 到达终态时从其会话聚合一次，写入 Run 记录，此后视为不可变（ADR-0011）。这是对「执行侧真相留在会话、不双写」的**刻意例外**，理由是「Run 结束后用量永不再变」这一天然不变量。
- 进行中的 Run 另行订阅会话事件显示实时进度，该计数**不持久化**。
- Run 异常终止导致字段缺失时显示为未知，不回退到零值。

### HTTP 面

- 路由经 `ctx.effect(() => ctx.webServer.register(...))` 注册，随 fiber 清理。
- Board 快照接口用 `Cache-Control: no-store`。
- path decode、请求体解析、handler rejection 全部转成明确 4xx/5xx，不产生未处理 rejection。
- 未知插件资源返回 404，不落入 SPA fallback。

### Client 面

- 导航项注册到 `sidebar.footer.action`（`{ kind: 'list', scope: 'root' }`），接收 `{ wide }`，折叠态需渲染紧凑图标。
- Board 面板注册到 `shell.overlay`（`{ kind: 'list', scope: 'root' }`）。容器是 `absolute inset:0; z-index:20; pointer-events:none`，entry 需自行开启 pointer events。
- **不抢占 `conversation` 单槽**，也不碰 `root` 单槽（ADR-0002）。
- Board 全幅覆盖，不试图为 sidebar 让位——`shell.overlay` 的 owner props 是空对象，entry 拿不到 sidebar 的 `collapsed`/`width`。
- 拖拽用打进 client bundle 的第三方 dnd 库；purity gate 只管 `@deepseek-ai/` 作用域，非该作用域的 specifier 放行。
- 所有注册、controller、listener、style、DOM 随 client fiber dispose。
- 轮询用 `no-store` + in-flight guard + 响应形状校验 + unmount 防护；失败保留最后一次成功快照。
- 支持键盘、`:focus-visible`、`aria-*`、Escape、reduced motion。

### UI 来源与许可义务

Board UI 从 Multica 的 `packages/views/issues/` 与 `packages/ui/` 移植（ADR-0005）。移植不是拷贝即用：需逐文件替换取数层（react-query）、模型层（`@multica/core/*`）、组件层（shadcn/ui）与样式体系（Tailwind → CSS Modules）。

**随附义务**：Board 界面必须保留 Multica 的 logo、产品名与版权署名；每个派生文件在头部注释标注 Multica 来源路径；任何再分发必须完整交付整个 Multica LICENSE 文件与 NOTICE。

## Testing Decisions

好的测试只断言**外部行为**，不断言实现细节。本 feature 的接缝数量下限由框架决定：host 与 client 是两个独立 tsc program 与两个运行时，无法合并，因此是 2 个主接缝 + 1 个组合门禁。

### 接缝 ①（host，最高接缝）：插件的 HTTP 路由

客户端能对 Board 做的一切都经由此处，因此在这一层测试覆盖面最大而接缝最少：

- Issue 与 Run 的创建、编辑、删除、查询
- 六 Lane 状态机的全部合法迁移，以及非法迁移被拒绝
- 分数索引排序：同 Lane 内重排、跨 Lane 移动、边界插入
- 执行配置解析顺序（Issue 覆盖 → 全局默认）
- Run 生命周期：启动 → Running、成功 → 待验收、失败 → Failed、`maxAttempts` 用尽
- Gate 接受与退回
- Token 快照在终态写入一次、异常终止时缺失
- 校验失败与错误码；请求体畸形不产生未处理 rejection
- 存储：文件往返、原子发布、并发写串行化、崩溃后不留损坏快照

`sessions` 用 fake service，不真跑 Agent；存储指向临时目录。

**刻意不给状态机与排序函数单独接缝**——它们是纯函数且从此接缝完全可达。若某条迁移无法从 HTTP 触达，那是 HTTP 面不完整的信号，不是需要新接缝的理由。

### 接缝 ②（client）：SlotTestRuntime mount

jsdom lane，通过 SlotTestRuntime 或最小 fake services 挂载插件：

- 导航项注册进 `sidebar.footer.action`，宽窄两态都渲染
- Board 面板注册进 `shell.overlay`，能开能关，Escape 生效
- 拖拽产生正确的 API 调用与乐观更新
- 连接重置后只重同步已读过的对象
- **dispose 后 registry、DOM、style、controller 全部清理**（每个 registry 贡献至少一个 HMR/dispose 安全测试）

### 组合门禁（不是单测接缝）

- 至少一个测试通过真实 Loader/patch 组合启动，断言用户可见表面——不只手搓 `ctx.plugin()`。
- 全新临时 `DSH_HOME` + scratch profile：`dsh plugin add` → 断言 profile 依赖与 `dsh.profile.bundles` → `dsh --profile <scratch> --dump-config` 出现插件层与正确的行 id / name / config。
- 断言所有 exports、host/client bundle、patch 与静态资源真实存在。
- GUI 用独立 web profile 与真实浏览器验证：导航项、打开关闭、拖拽、刷新、宽窄屏、滚动、焦点、reduced motion。

### 现有参考（prior art）

按 dsh 官方模板取证，不自创协议：Host Service 与 HTTP 参考 `packages/host/webserver`；持久化的原子发布与 no-clobber 参考 `packages/storage/storage-json` 与 `packages/session/session-persistence-jsonl`；最小 client 插件参考 `packages/client/ui-message-feedback`；slot 契约参考 `packages/client/ui-conversation` 与 `ui-slots`；client 测试参考 `packages/test-support/client-runtime`。

## Out of Scope

- **多用户与团队协作**：角色、访问范围、成员、登录。dsh 只绑回环且明确拒绝 `--host 0.0.0.0`（ADR-0001）。Issue 上不设 assignee-to-human。
- **Agent 写 Board**：不注册工具，Agent 不能创建 Issue、不能推动 Lane、不能给自己派活（ADR-0012）。
- **可配置 Lane**：Lane 集合固定六个（ADR-0009）。
- **自建 daemon 与外部 CLI 矩阵**：v1 的 agent 覆盖面等于 dsh 的覆盖面（ADR-0004）。
- **默认自动重试**：机制在位但默认关闭（ADR-0010）。
- **Board 变更审计历史**：快照不保留「谁在何时把卡片拖到哪一列」。若日后需要，追加独立 JSONL 审计流，而不是把快照改成事件日志（ADR-0006）。
- **Issue 依赖关系、子 Issue、标签、评论、反应、甘特图/泳道视图**：Multica 有，v1 不做。
- **接管 `user-approval` 的展示**：Board 至多旁观（ADR-0008）。
- **对外分发与商业化**：一旦发生，Board UI 需重写或取得商业许可（ADR-0005）。

## Further Notes

### 实施前必须清掉的证据缺口

以下假设**尚未取证**，其中第 1 项是门禁——必须在投入 UI 移植之前有结论，否则若执行路径不成立，产品形态需重新讨论：

1. **`ctx.sessions.create()` 之后由谁驱动 agent loop**——Run 真正跑起来的完整路径。ADR-0013 的地基。
2. **会话事件中 `usage` 字段的确切形状与聚合方式**。ADR-0011 依赖。
3. **`sidebar.footer.action` entry 的完整 props 契约**与折叠态渲染要求。
4. **第三方 dnd 库打进 client bundle 的实际构建结果**——purity gate 的契约测试显示非 `@deepseek-ai/` 作用域放行，但 tsdown 打包 + CSS Modules 组合未实跑验证。

### 实施顺序（按风险递减）

先做**骨架穿刺**：host 一条返回空 Board 的路由 + client 的导航项与空面板，不含业务逻辑，但一刀穿透全部框架接缝，并走完整的全新 profile 安装验证。**状态机与持久化**可并行开发，因为它完全脱离 dsh 可单测。之后是**UI 移植**（工作量最大、风险最低），再是**Run 执行**（依赖缺口 1），最后是 **Gate 与可观测**、**从会话提取 Issue**。

### 演进风险

dsh 处于 developer preview，无兼容承诺、无 release tag。slot 名、平台模块表、service 接口都可能漂移。实现时一切以当前 checkout 的实际代码为准，不凭本 spec 或旧文档猜；发现漂移时用 `packages/README.md` 重新定位并回报修正。
