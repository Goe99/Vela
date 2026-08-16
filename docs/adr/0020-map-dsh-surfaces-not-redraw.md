---
status: accepted
---

# 保留 Multica 导航的形状，但 DSH 已有的界面只做入口不重画

Vela 的左侧导航按 Multica 的三组十二项**原样摆好**，但每一格背后的实现分三种：Vela 自己画的、点了跳去 DSH 的、以及灰着占位标注「下一期」的。

Vela 自己画的只有三处：**Board、Squad 编辑器、Issue 详情抽屉**。其余全是入口。

## 归属表

| Multica 的项 | 归属 |
|---|---|
| Inbox | **改语义** → 「待你处理」：待验收 + 失败的卡数，带徽标 |
| Chat | 关掉 Vela 面板，露出下面 DSH 自己的会话界面 |
| My Issues / Issues | Vela 的 Board（默认页） |
| Agents | 调 DSH 的 `agentPresets.openDocument`，把 agent 配置目录交给系统打开 |
| Squads | Vela 的 Squad 编辑器 |
| Runtimes | 调 DSH 的 `settings.openDocument`，打开设置文件 |
| Skills | 置灰，悬停说明原因：DSH 没有独立的 Skills 页面 |
| Settings | 调 DSH 的 `settings.openDocument`，打开设置文件 |
| Projects / Autopilots / Usage | 灰着占位，悬停标注「下一期」 |

## 取证推翻了「跳过去」这个词

本 ADR 初稿写的是「点了跳到 DSH 的 Skills 页 / 设置页 / agent 配置列表」。对着实际安装的运行时查完，这句话站不住，上面的表已经改正：

**DSH 里不存在给第三方插件的页面导航能力。** 没有 router / navigate / route 之类的服务；`ctx.layout` 只有 `toggleSidebar` / `openDetails` / `closeDetails` 三个方法，它们只改面板几何，不改当前显示的内容。唯一能程序式达成的导航是 `ctx.sessions.open(sessionId)`。

**设置页不是一个可导航的目标，而是一堆插槽。** agent preset 列表、权限档位那些“页”都是注册到 `settings.section` / `settings.general.item` 里的条目，由设置壳自己的内部状态决定当前显哪一个，没有对外的「打开设置并定位到某分区」接口。

**DSH 根本没有独立的 Skills 页面。** Skills 以工具调用视图的形式渲在对话里，不是一个可以“去”的地方。所以这一格不是「跳不过去」，而是「没有目的地」。

本 ADR 的「只做入口不重画」**结论不变**，但「入口」收窄为三种真存在的动作：关掉自己的面板以露出下面的 DSH、调 DSH 的 `openDocument` 把对应配置文件交给系统编辑器、以及切会话。

## 为什么不重画

重画一份设置页等于维护两套，DSH 升级就散架。而 Operator 要的本来就是「这些功能的实现是 DSH 内置的那一份」——重画反而背离目标。

**Inbox 是唯一一处换掉语义而非接过来的。** DSH 没有收件箱，而 Multica 的 Inbox 语义（别人给你发的消息）在单 Operator 的世界里根本不存在（ADR-0001）。空着一格不如把它换成这个位置真正该有的东西：需要你动手的卡有多少张。

**灰着占位而不是隐藏。** Multica 的形状因此完整可见，路线图也一眼可见——Operator 不需要翻文档才知道什么还没做。

## Issue 详情用抽屉，不用整页

Vela 是 DSH 里的一个覆盖层。整页详情会和 DSH 自己的界面抢地方，而右侧抽屉（占屏幕右侧约四成）让 Board 始终留在视野里——「还在看板上」这个感觉是 Board 作为指挥主界面的前提。

这一处**偏离 Multica**：Multica 的 Issue 详情是整页路由。偏离的理由是宿主形态不同，不是审美偏好。

## Considered Options

- **在 Vela 面板里重画 Skills 与设置** — 拒绝，理由见上。
- **隐藏做不到的项** — 拒绝。导航长度会随开发进度变化，且 Operator 无从得知还有什么在路上。
- **Issue 详情做成整页，与 Multica 一致** — 拒绝。宿主是覆盖层，整页会遮掉 Board。

## Consequences

**导航里没有一个项是“真正的页面跳转”。** 这不是实现上的偋懒，而是宿主的事实（见上节）。任何日后想给导航加项的人必须先回答「点下去到底发生什么」，而不能假设有个 router 可用。

**归属表本身要有测试锁住。** 锁的是「十二项每一项都有明确归属，没有一项悬空」，而不是锁具体的跳转目标——后者会随 DSH 变化，锁死它只会制造无意义的失败。

**置灰分两种原因，提示文案不能混。** Projects / Autopilots / Usage 是「我们还没做」；Skills 是「DSH 没有这个页面可去」。把后者写成「下一期」会让 Operator 误以为是 Vela 欠工。
