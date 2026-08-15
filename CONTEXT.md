# Vela

一个 DeepSeek Harness (DSH) 插件，让单个操作者像管理同事一样指派、追踪并验收多个 AI agent 的工作。

## Language

### 人与视图

**Operator**:
使用 Vela 的那个人。Vela 假定始终只有一个 Operator，没有身份、登录或成员概念。
_Avoid_: User, Owner, Member, 用户

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
针对某个 Issue 的一次执行尝试，对应一个 agent 会话。一个 Issue 可以有零到多个 Run。
_Avoid_: Task, Job, Attempt, Execution, 执行记录

**Agent**:
承接一个 Run 的执行者。在 Vela 语境下指在 Run 自己的顶层会话里运行的 DSH agent，而非泛指的 AI 助手。
_Avoid_: Worker, Bot, Subagent, 智能体

**Gate**:
Run 产出后等待 Operator 判定接受或退回的验收环节。Gate 是异步的、可积压的，不打断 Agent 执行。
_Avoid_: Approval, Review, Check, 审批, 闸门
