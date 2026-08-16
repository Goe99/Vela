# Vela

一个 DeepSeek Harness (DSH) 插件，让单个操作者像管理同事一样指派、追踪并验收多个 AI agent 的工作。

## Language

### 人与视图

**Operator**:
使用 Vela 的那个人，也是 Vela 里唯一的人。Vela 假定始终只有一个 Operator，没有身份、登录或人的成员概念。
_Avoid_: User, Owner, 用户, 协作者

注：`Member` 曾在此列为需避开的词。自 Squad 引入后它有了自己的确切含义——小队里的一个 **agent** 位置，与人无关（见「小队」一节）。

**Board**:
把所有 Issue 按状态分列铺开的可视化视图，是 Operator 指挥工作的主界面。
_Avoid_: Kanban, 看板视图, View

**Lane**:
Board 上的一列，恰好对应一个 Issue 状态。固定六列：Backlog、Todo、Running、待验收、Done、Failed。
_Avoid_: Column, Stage, 泳道

**Workspace**:
一个被指派工作的代码库根目录。沿用 DSH 既有含义，指一个项目目录，**不是**多租户边界。
_Avoid_: Project, Tenant, 组织, 团队

### 工作与执行

**Issue**:
Board 上的一张卡片，代表一件要交付的事。Issue 的寿命长于它的任何一次执行——未指派时就已存在，被重试多次后依然是同一个 Issue。
_Avoid_: Task, Card, Ticket, 任务

**Run**:
针对某个 Issue 的一次执行尝试。它的范围是 Leader 的那个顶层会话，**加上**这次执行中派生出的全部 Member 子会话。一个 Issue 可以有零到多个 Run。
_Avoid_: Task, Job, Attempt, Execution, 执行记录

**Agent**:
承接工作的执行者，永远是 AI，从不是人。一个 Run 里可能有多个 Agent 同时在跑：Leader 在 Run 的顶层会话里，每个被派生的 Member 在自己的子会话里。
_Avoid_: Worker, Bot, 智能体

**Gate**:
Run 产出后等待 Operator 判定接受或退回的验收环节。Gate 是异步的、可积压的，不打断 Agent 执行。
_Avoid_: Approval, Review, Check, 审批, 闸门

### 小队

**Squad**:
一个具名的 Agent 组合，由恰好一个 Leader 和零到多个 Member 组成，可跨 Issue 反复复用。一个 Squad 持久化为一份 DSH agent preset 目录，因此 DSH 自己的会话入口也能选到它。
_Avoid_: Team, Group, Crew, 团队, 小组

**Leader**:
Squad 里唯一直接承接 Run 的 Agent。它持有 Squad 的 Instruction，并**自行决定**把哪部分工作派给哪个 Member——Vela 不代它分派。Run 的成败只看 Leader 怎么收尾。
_Avoid_: Coordinator, Manager, Orchestrator, 主管, 协调者

**Member**:
Squad 中的一个 Agent 位置，有自己的名字、Instruction 和工具白名单。Member 只能由 Leader 派生，**永不**直接承接 Run，也永不出现在 Board 上作为独立卡片。
_Avoid_: Subagent, Child, Worker, 成员, 下属

**Instruction**:
写给某个 Leader 或 Member 的**常驻**职责说明，随 Squad 一起持久化，作为该 Agent 的系统设定生效。与 Issue 的描述严格区分——后者是一次性的任务内容，前者跨 Run 不变。
_Avoid_: Prompt, Persona, System Prompt, 提示词, 人格

**Delegation Slot**:
一个 Member 同时在跑的额度。每个 Squad 持有固定数量的 Delegation Slot，Member 起跑前必须先领到一个、结束后交还。领不到就排队等——这是硬拦截，不是对 Leader 的劝告。
_Avoid_: Quota, Limit, Semaphore, 并发数, 令牌
