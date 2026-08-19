# 12 — 加队员弹窗：组件与交互集成

**What to build:** 点小队详情页成员 tab 的「+ 加队员」，打开一个模态弹窗（遮罩压暗、弹窗居中），弹窗内展示 6 张预设角色卡（工程师 / 研究员 / 审查员 / 界面设计师 / 文档员 / 数据分析师）+ 1 张空白队员卡。点任一卡片：用该模板（或空白）把队员加入草稿，弹窗自动关闭——点卡即加，不做选中态、不做表单。右上 X、点遮罩、按 Esc、底部「取消」四种方式都能关窗且不加人；Esc 只关弹窗，不连带关掉整个面板（沿用创建小队弹窗的捕获阶段拦截写法）。原来的内联展开交互移除，按钮不再有「收起」态。弹窗结构复用现有 modal 基建（backdrop / modal / head / body / foot），样式沿用 `--vela-*` 变量。形态参考 waker-replica/waker-ui-tokens.md 第 4 节，规格详见 waker-replica/add-member-dialog-spec.md。

**Blocked by:** None — can start immediately

**Status:** done

- [x] 点「+ 加队员」打开弹窗，背景被遮罩压暗，详情页内容不再被顶下去
- [x] 弹窗内可见全部 6 张角色模板卡和 1 张空白队员卡
- [x] 点模板卡：对应队员加入成员列表且弹窗关闭；点空白卡：加入空白队员且弹窗关闭
- [x] X / 点遮罩 / Esc / 取消 四种方式只关窗不加人；按 Esc 时外层面板保持打开
- [x] 现有测试全部通过

## Comments

- 2026-08-19 自 `waker-replica/issues/01-add-member-dialog.md` 抄入（经 Operator 确认，grill 轮 Q1）。弹窗内卡片网格固定两列；宽度先保持 560px，浏览器实测拥挤再调至 ~640px（Q2）。提示文案：「点一张卡直接加入小队——名字、职责、能力加进来后都能在队员卡里改。」（Q5）
- 2026-08-19 完成。新增 `src/client/components/AddMemberDialog.tsx`（沿用 CreateSquadDialog 的 modal 基建与 Esc 捕获拦截）；`SquadDetail` 的内联展开移除，按钮恒定「+ 加队员」。自动测试 `tests/client/add-member-dialog.spec.ts` 覆盖结构；行为项在全新 DSH_HOME + link 安装的实例上经浏览器实测通过（含 Esc 不连带关面板、空白卡加 member_1）。`pnpm verify` 697 测试全绿。
