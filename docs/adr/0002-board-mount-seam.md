---
status: accepted
---

# Board 挂在 sidebar.footer.action + shell.overlay，不抢占 conversation 单槽

DSH 的客户端 UI 没有 URL 路由，也没有「非会话视图」这一状态——`sessions.current` 的类型只有 `SessionId | undefined`，导航完全由 `sessions.open()` / `clear()` 驱动。这意味着框架不存在「与会话平级的独立页面」这个概念。Board 需要全幅、跨会话、长驻，因此选择：**在 `sidebar.footer.action`（`{ kind: 'list', scope: 'root' }`）注册导航入口，在 `shell.overlay`（`{ kind: 'list', scope: 'root' }`）渲染 Board 面板**。两者都是 root scope 的加法式座位，注册它们不移除任何既有能力。

## Considered Options

- **注册成 `conversation.view`** — 拒绝。该 slot 是 `{ kind: 'list', scope: 'session' }`，Board 会被每个会话各实例化一份、切会话即重置，与「跨会话的全局项目视图」语义直接冲突。
- **抢占 `conversation` 单槽** — 拒绝。该 slot 由 ui-conversation 的 ConversationRoot 占据，替换它会连带摧毁其声明的全部内部座位（session、header、composer、composer.bar、input.dock、composer.dock、input.left/right、hero.workspace、hero.agentPreset 等约 11 个），且框架不提供装饰/包装模式——`priority` 只用于 chain slot 选举与 list 排序，single slot 上是彻底替换。
- **向 ui-layout 新增 `main.content` slot** — 拒绝。需要改 DSH 核心代码，插件无法在正式版上分发。

## 几何：全幅覆盖

Board 打开时**全幅覆盖整个 AppFrame（含 sidebar 之上）**，Escape 关闭；点击某个 Run 时调用 `sessions.open()` 并同时关闭 Board。

除了实现最简，这里还有一条硬约束：`shell.overlay` 的 owner props 是空对象（AppFrame 中为 `renderSlot('shell.overlay', {})`），entry **拿不到 sidebar 的 `collapsed` / `width`**。任何「只覆盖中间列与 details 列、保留 sidebar 可见」的方案都得去 `ctx.layout` 里刨面板状态或硬编码列宽，两者都会随上游布局变动而碎。

语义上也更对：打开 Board 是「切换到项目视角」，不是「在会话旁边瞄一眼」；点 Run 跳会话时 Board 关闭，动线闭合。

## Consequences

`shell.overlay` 的语义是浮层而非页面：容器为 `position: absolute; inset: 0; z-index: 20; pointer-events: none`，子元素需自行恢复 `pointer-events: auto`。因此 Board 必须自己承担尺寸与定位、Escape 关闭、焦点管理与窄屏上限。这是接受的代价——换来的是零破坏性与可升级性。
