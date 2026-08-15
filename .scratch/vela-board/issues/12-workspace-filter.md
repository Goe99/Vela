# 12 — Workspace 筛选与跨项目视图

**What to build:** Board 默认只显示当前 Workspace 的活，避免一个项目的待办被其他项目淹没；也能切到全部视图，回答「今天该推哪个项目」——这正是单 Operator 处境下最需要的那个判断。

**Blocked by:** 04 — 创建 Issue 并在 Board 上展示

**Status:** done

- [x] Board 默认只显示当前 Workspace 的 Issue
- [x] 可切换到全部 Workspace 视图
- [x] 全部视图下每张卡片显示其所属 Workspace
- [x] 筛选状态的变化**不改写**快照中的任何 Issue
- [x] 筛选与拖拽排序互不干扰：在筛选视图里拖动不会破坏被隐藏卡片的相对次序
