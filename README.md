# Vela

**Vela** 发音 `/ˈvɛlə/`，拉丁语意为「帆」，也是南天星座 **船帆座** 的名字。

帆本身不产生动力，它只是顺应风力——看似无为，却能让整艘船乘风破浪、高速前行。这正是 Vela 的隐喻：**AI 是你的风，Vela 是你的帆**。它不替你做决定，只是让 AI 驱动的任务井井有条，帮你一个人像一支队伍一样运转。

——

单 Operator 的 AI Agent 项目管理面板，作为 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 插件运行。像管理同事一样为 Agent 派活、追踪进度、验收产出。

> Board UI 的设计与部分实现移植自 [Multica](https://github.com/multica-ai/multica)。**Powered by Multica** — 依据 Multica License 条件 (b)，界面保留 Multica 署名。

## 这是什么

一个全幅看板：所有 Issue 按状态分列在六个固定 Lane（Backlog / Todo / Running / 待验收 / Done / Failed）上，跨 Workspace 统一呈现。在卡片上一键派活，Agent 在一个独立的 dsh 顶层会话里执行；干完后卡片进入「待验收」，由 Operator 接受或退回——Agent 有权交付，无权宣布通过。

设计决策见 [`docs/adr/`](./docs/adr)，术语见 [`CONTEXT.md`](./CONTEXT.md)，需求见 [`.scratch/vela-board/spec.md`](./.scratch/vela-board/spec.md)。

## 功能

- **六列看板**：固定 Lane，每列恰好是状态机的一个节点（ADR-0009）。拖拽重排与跨列移动，非法落点在 drop 时即被拒绝。Alt + 方向键是等价的键盘操作。
- **一键派活**：Agent 在自己的 dsh 顶层会话里真实执行，卡片自动进 Running。会话以 Issue 标题命名，在侧栏里可辨认。
- **验收闸门**：执行成功只到「待验收」，**永远不自动进 Done**。接受进 Done，退回回 Todo。
- **失败与重试**：失败原因直接写在卡片上。自动重试机制在位但**默认关闭**（ADR-0010），可按卡片开启。
- **Token 用量**：进行中显示实时值（不落盘），结束时快照入 Run。异常终止导致缺失时显示未知，不显示 0。
- **per-Issue 执行配置**：agent preset、权限档位、超时可按卡片覆盖，未覆盖的回落到全局默认。派活不弹对话框。
- **Workspace 筛选**：默认跳看全部，可按 Workspace 收窄。
- **批量建卡**：粘贴多行文本，一行一张卡片，整批落盘或一张也不落。

## 架构

- **host half**（`src/index.ts` + `src/domain` + `src/http` + `src/runner.ts`）：拥有 Board 状态机、JSON 快照持久化与派活执行器，经宿主 `webServer` 暴露 `/api/vela` 路由。不注册任何工具（ADR-0012）。
- **client half**（`src/client`）：`sidebar.footer.action` 导航项 + `shell.overlay` 全幅面板（ADR-0002）。拖拽用**浏览器原生 drag-and-drop**，不引第三方库——本来就要为键盘操作单独做一层，原生方案让 client bundle 保持零新增依赖。
- **领域层零 dsh 依赖**：Issue/Run 状态机、分数索引排序、用量折叠、快照读写都是纯逻辑，可脱离 harness 单测。
- **派活经官方 `apiProxy` 服务**，不 import 任何 `@deepseek-ai/*` 运行时模块（ADR-0015）。对 dsh 的接触面用**结构化最小接口**声明（`src/dsh.ts`）——dsh 处于 developer preview，这样对版本漂移免疫。

## 开发

```sh
pnpm install
pnpm typecheck   # host + client 两个 tsc program
pnpm test        # 领域 / HTTP / client 纯逻辑
pnpm build       # 产出 lib/index.mjs (host) + lib/index.js (client)
pnpm verify      # typecheck + test
```

## 安装到一个 dsh profile

```sh
dsh plugin --profile <name> add <本仓库路径>
```

随后重启目标 profile。面板需要 Web 界面，因此 profile 的 bundle 列表里 `@deepseek-ai/dsh-web-app` 必须排在 `dsh-vela` 之前。

### 配置

在 profile 的 `cordis.patch.yml` 里覆盖 `vela` 行：

| 项 | 含义 |
|---|---|
| `boardPath` | Board 快照的绝对路径，默认 `$DSH_HOME/vela/board.json`。**无 cwd 回落**（ADR-0006）。 |
| `exec.agentPreset` | 派活默认的 agent preset；省略则用 dsh 自己的有效默认。 |
| `exec.sandbox` | 派活默认的**权限 preset 名字**（不是 sandbox 档位取值，见 ADR-0014）；省略则沿用会话创建时钉入的用户默认。 |
| `exec.timeoutMs` | 派活默认的超时毫秒；0 或省略 = 不限时。 |

未挂载 `apiProxy` 的 profile 仍可看看板、建卡、排序与验收，只是**派活按钮不出现**。

## 状态

spec 拆出的 13 张票均已实现并经真实启动验证：一次真实派活已确认 Agent 在工作目录里完成了任务、卡片自动流到待验收而非 Done、token 用量正确快照，接受后进 Done 且非法迁移被 409 拒绝。

与票面描述不同的两处，已在上文说明：拖拽用原生方案而非 dnd-kit；票 13 的「从会话一键提取」实现为看板内的批量建卡（粘贴清单），而不是会话内的入口——后者需要一个 session-scoped slot，属于后续增量。
