# 13 — 从当前会话提取 Issue

**What to build:** 和 Agent 聊出一批待办之后，一键把它们落成 Board 上的 Issue，不用逐条重打一遍。这是「派活成本高」这个痛点的最后一块——规划对话与待办清单之间不该有手工搬运。

**Blocked by:** 04 — 创建 Issue 并在 Board 上展示

**Status:** partially done

- [ ] Operator 在一个会话中可一键把讨论出的待办提取成 Issue
- [x] 提取出的 Issue 只进 Backlog Lane，**不会**被自动派活
- [x] 提取动作由 Operator 触发；Vela **不为此注册任何工具**，Agent 无法自行写入 Board
- [ ] 提取的 Issue 默认以该会话的工作目录作为 Workspace
- [x] 落盘前 Operator 可调整标题与条目数量
- [x] 提取写入与 Board 的其他写入共用同一条串行化路径

## 完成记录：只做了一半

**做了的**：看板内的**批量建卡**——建卡表单勾上「一行一张」后可粘贴多行文本，一行一张卡片，整批落盘或一张也不落（共用同一次 mutate）。这解决了本票的核心痛点：**不用逐条重打**。Operator 从对话里复制清单粘过来即可。

**没做的**：会话内的「一键提取」入口，以及自动把该会话的工作目录当作 Workspace。两者都需要一个 **session-scoped slot entry**（例如 `conversation.session.header.actions`）才能拿到当前会话与它的 cwd——而 Board 面板是 root scope 的，定义上就不知道“当前会话”。那个接缝的 props 形状我未取证，不想靠猜实现。

**现状的代替**：Workspace 字段默认预填为当前筛选中的那个，否则是最近用过的那个，因此多数时候不用手填路径。
