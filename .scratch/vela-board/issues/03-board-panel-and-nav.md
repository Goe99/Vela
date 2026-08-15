# 03 — Board 面板与导航入口

**What to build:** Operator 在 sidebar 页脚看到一个 Board 入口，点击后一个全幅面板铺开覆盖整个界面，Escape 关闭。面板此刻显示空 Board 的占位内容。导航项与面板是两个独立的 slot entry，但共享同一份「是否打开」的状态。

**Blocked by:** 01 — 插件骨架与从零安装验证

**Status:** done

- [x] 导航项注册进 `sidebar.footer.action`，宽态与折叠态都可用，折叠态渲染紧凑形态
- [x] 面板注册进 `shell.overlay`，全幅覆盖整个 frame（含 sidebar 之上），自行开启 pointer events
- [x] 两个 entry 通过注册时声明的共享 store 同步开关状态，不各自持有一份
- [x] Escape 关闭面板；打开时焦点锁在面板内；关闭后焦点回到导航项
- [x] 支持键盘操作、`:focus-visible`、`aria-*` 与 reduced motion
- [x] 窄屏下面板有高度上限，内容区内部滚动，不裁切
- [x] **不**注册 `conversation` 单槽，**不**碰 `root` 单槽
- [x] client 面测试经 SlotTestRuntime 挂载，断言两处注册、开关、Escape，以及 dispose 后 registry / DOM / style / controller 全部清理
- [x] 包在此票补上 client 导出与 `dsh.client.platform`，且**不**开启 `immediately`
- [x] client bundle 通过 purity gate：未越过平台模块表
