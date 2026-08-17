/**
 * Vela 的样式。以一个 `<style data-plugin>` 标签注入——这与 DSH 自己的 client
 * 包做法一致，且让我们能用 hover、`:focus-visible`、媒体查询与 reduced-motion，
 * 这些是内联 style 表达不了的。
 *
 * ## 为什么自带色板而不是直接用 `--dsw-alias-bg-*`
 *
 * 曾经的实现把面板/泳道/卡片三层分别映射到 `bg-base` / `bg-layer-1` /
 * `bg-layer-2`。这在夜间可用，在日间**完全塌掉**：DSH 的 design-platform.css 在
 * 日间把这四个背景别名全部指向同一个 `neutral-bluish-00`（纯白），于是三层结构
 * 变成一张白纸，六条泳道彼此看不出边界。
 *
 * 因此这里自定义一套 `--vela-*` 局部变量作为三层表面阶梯（画布 < 泳道 < 卡片），
 * 卡片在日间是纯白并带极轻阴影，"浮"在偏灰的画布上。这是 DSH 文档所说的
 * 「CSS 变量桥」：颜色集中在一处声明，夜间只覆盖同一组变量。
 *
 * 明暗钩子用 `body[data-ds-dark-theme]`——它是 DSH 主题包自己切换两套调色板所用
 * 的选择器。第三方插件无法向 ui-theme 注册 token，只能这样跟随宿主主题；代价是
 * 这个选择器出现在插件样式里（DSH 内部包的规范不允许，但那条规范的前提是能改
 * ui-theme）。
 *
 * 色相与 DSH 的 `neutral-bluish` 同属偏蓝灰系，因此关掉面板时不会有色温跳变。
 *
 * 选择器只依赖稳定的 `data-vela-*` 属性，不耦合任何哈希 class。
 */

/** 注入用的标识，也是清理时的定位依据。 */
const TAG = 'dsh-vela'

const CSS = `
/* ── 色板：日间 ─────────────────────────────────────────────
   三层表面必须**逐级不同**，这正是日间模式曾经坏掉的地方。
   ───────────────────────────────────────────────────────── */
[data-vela-panel],
[data-vela-nav],
[data-vela-extract],
[data-vela-extract-open] {
  /* 画布：面板底色，比泳道暗一档，让泳道浮出来 */
  --vela-canvas: #e4e9f2;
  /* 泳道底色 */
  --vela-lane: #f7f9fc;
  /* 六列各自的淡色泳道。backlog 最中性（还没排上），往后各有色彩身份：
     todo 蓝、running 琥珀、review 紫、done 绿、failed 红。 */
  --vela-lane-backlog: #edeef2;
  --vela-lane-todo: #e6edfa;
  --vela-lane-running: #faf1de;
  --vela-lane-review: #efebfa;
  --vela-lane-done: #e4f3ea;
  --vela-lane-failed: #faeaea;
  /* 卡片：日间纯白 + 轻阴影，浮在泳道上 */
  --vela-card: #ffffff;
  /* 主分隔线（泳道边框） */
  --vela-line: #d8e0ec;
  /* 次级分隔线（卡片边框、内部分隔） */
  --vela-line-soft: #e6ecf5;
  --vela-text: #16202e;
  --vela-text-2: #55637a;
  --vela-text-3: #8d99ad;
  /* 强调色：靛蓝。同时是"正在跑"的信号色，因此这个颜色带含义 */
  --vela-accent: #3557d8;
  --vela-accent-hover: #2b49bd;
  --vela-accent-text: #ffffff;
  --vela-accent-soft: #e8edfd;
  /* 待验收的标识色：紫色，与进行中（琥珀）和完成（绿）都拉开 */
  --vela-purple: #6d4fc4;
  --vela-ok: #1f9d66;
  --vela-danger: #d33a4b;
  --vela-danger-soft: #fdeff1;
  --vela-warn: #a55a00;
  --vela-warn-soft: #fff4e0;
  /* 中等优先：介于默认与高之间的青蓝。早期 low/medium 共用默认样式，于是
     四档优先只有两种颜色——浏览器里实测确认“低”与“中”在颜色上分不开。 */
  --vela-info: #1f6f8f;
  --vela-info-soft: #e4f2f8;
  --vela-hover: #e6ecf5;
  /* 弹窗遮罩 */
  --vela-scrim: rgba(21, 32, 46, .38);
  /* 输入框的凹槽底色：比卡片深一点，形成「凹进去」的层次 */
  --vela-inset: #edf0f7;
  /* 字母徽的六色盘：同一个名字永远同一个色，日夜共用（饱和度够，白字上都成立） */
  --vela-avatar-0: #4f6fd8;
  --vela-avatar-1: #7c5cd6;
  --vela-avatar-2: #2f9264;
  --vela-avatar-3: #c47b1e;
  --vela-avatar-4: #c94f7c;
  --vela-avatar-5: #2a8fa0;
  --vela-avatar-text: #ffffff;
  --vela-card-shadow: 0 1px 2px rgba(21, 44, 92, .07), 0 1px 3px rgba(21, 44, 92, .05);
  --vela-scroll: #c9d4e5;
  --vela-scroll-hover: #adbdd4;
}

/* ── 色板：夜间 ─────────────────────────────────────────────
   只覆盖同一组变量；下面所有规则都不再关心明暗。
   ───────────────────────────────────────────────────────── */
body[data-ds-dark-theme] [data-vela-panel],
body[data-ds-dark-theme] [data-vela-nav],
body[data-ds-dark-theme] [data-vela-extract],
body[data-ds-dark-theme] [data-vela-extract-open] {
  --vela-canvas: #101319;
  --vela-lane: #1a1f2a;
  /* 六列淡色泳道的夜间版：同一套色相，压暗到刚好能辨 */
  --vela-lane-backlog: #171a21;
  --vela-lane-todo: #16202e;
  --vela-lane-running: #251e13;
  --vela-lane-review: #1e1930;
  --vela-lane-done: #15251c;
  --vela-lane-failed: #2a1618;
  /* 卡片比泳道亮一档。早期取 #212734，与泳道只差十几个度——浏览器里
     实测确认卡片基本浮不起来。 */
  --vela-card: #262e3d;
  --vela-line: #313a4b;
  --vela-line-soft: #272e3b;
  --vela-text: #e6ecf5;
  --vela-text-2: #a3b0c4;
  --vela-text-3: #7a879b;
  --vela-accent: #5b7cf7;
  --vela-accent-hover: #7290fa;
  --vela-accent-text: #0b0e13;
  --vela-accent-soft: #1e2740;
  --vela-purple: #9d84f0;
  --vela-ok: #57c98a;
  --vela-danger: #ff7f88;
  --vela-danger-soft: #2c1b20;
  --vela-warn: #f0b959;
  --vela-warn-soft: #372a15;
  --vela-info: #6ec5e0;
  --vela-info-soft: #142a33;
  --vela-hover: #272e3b;
  /* 弹窗遮罩 */
  --vela-scrim: rgba(0, 0, 0, .55);
  /* 输入框的凹槽底色：深色界面的输入框要比所在表面更深，不是更亮 */
  --vela-inset: #141821;
  /* 字母徽六色盘与日间同值 */
  --vela-avatar-0: #4f6fd8;
  --vela-avatar-1: #7c5cd6;
  --vela-avatar-2: #2f9264;
  --vela-avatar-3: #c47b1e;
  --vela-avatar-4: #c94f7c;
  --vela-avatar-5: #2a8fa0;
  --vela-avatar-text: #ffffff;
  /* 夜间不需要阴影抬升：亮度差本身就够了 */
  --vela-card-shadow: none;
  --vela-scroll: #313a4b;
  --vela-scroll-hover: #43506b;
}

/* ── 面板 ───────────────────────────────────────────────── */

[data-vela-panel] {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  /* overlay 父层是点击穿透的；面板自己收回事件。 */
  pointer-events: auto;
  /* 不透明背景是必须的：没有它，下面的会话界面会透上来并与看板文字重叠。 */
  background: var(--vela-canvas);
  color: var(--vela-text);
  font-size: 13px;
  line-height: 1.5;
}

[data-vela-bar] {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 13px;
  border-bottom: 1px solid var(--vela-line);
  background: var(--vela-lane);
  flex: 0 0 auto;
}

[data-vela-title] {
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.01em;
}

[data-vela-brand] {
  font-size: 11px;
  font-weight: 400;
  color: var(--vela-text-3);
}

[data-vela-spacer] { flex: 1 1 auto; }

[data-vela-filter] {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--vela-text-2);
}

/* ── 控件 ───────────────────────────────────────────────── */

[data-vela-panel] button {
  font: inherit;
  color: var(--vela-text-2);
  background: var(--vela-card);
  border: 1px solid var(--vela-line);
  border-radius: 6px;
  padding: 3px 9px;
  cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
}

[data-vela-panel] button:hover:not(:disabled) {
  background: var(--vela-hover);
  color: var(--vela-text);
}

[data-vela-panel] button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

[data-vela-panel] button:focus-visible,
[data-vela-panel] input:focus-visible,
[data-vela-panel] select:focus-visible,
[data-vela-panel] textarea:focus-visible {
  outline: 2px solid var(--vela-accent);
  outline-offset: 1px;
}

/* 主操作（派活、接受、保存）：实心靛蓝，比纯黑温和得多 */
[data-vela-panel] button[data-tone='primary'] {
  background: var(--vela-accent);
  border-color: var(--vela-accent);
  color: var(--vela-accent-text);
  font-weight: 500;
}

[data-vela-panel] button[data-tone='primary']:hover:not(:disabled) {
  background: var(--vela-accent-hover);
  border-color: var(--vela-accent-hover);
  color: var(--vela-accent-text);
}

[data-vela-panel] button[data-tone='danger']:hover:not(:disabled) {
  background: var(--vela-danger-soft);
  border-color: var(--vela-danger);
  color: var(--vela-danger);
}

[data-vela-panel] input,
[data-vela-panel] select,
[data-vela-panel] textarea {
  font: inherit;
  color: var(--vela-text);
  background: var(--vela-card);
  border: 1px solid var(--vela-line);
  border-radius: 6px;
  padding: 4px 7px;
  width: 100%;
  box-sizing: border-box;
}

[data-vela-panel] textarea { resize: vertical; min-height: 44px; }

[data-vela-panel] input::placeholder,
[data-vela-panel] textarea::placeholder {
  color: var(--vela-text-3);
}

/* ── 六列网格 ───────────────────────────────────────────── */

[data-vela-grid] {
  flex: 1 1 auto;
  min-height: 0;
  display: grid;
  /*
   * 六列等宽。最小列宽要让一张卡读得下去（编号 + 不憋屈的标题 + 操作区），
   * 取 240px；剩余空间按 1fr 在各列间等比分配。六列总宽约 1544px，常见
   * 全屏（≥1600）能一屏放下；更窄的窗口就横向滚动，而不是把列压到读不了——
   * 「一眼看全」重要，但「每列读得下去」同样重要。
   */
  grid-auto-flow: column;
  grid-auto-columns: minmax(240px, 1fr);
  gap: 10px;
  padding: 12px;
  overflow-x: auto;
  overflow-y: hidden;
  align-items: stretch;
}

[data-vela-lane] {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border: 1px solid var(--vela-line);
  border-radius: 8px;
  /* 泳道体用这一列自己的淡色；没设 --lane-tint 的（比如时间轴的行）回落到默认泳道色。 */
  background: var(--lane-tint, var(--vela-lane));
  overflow: hidden;
}

/* 六列各自的色彩身份。--lane-tint 是泳道体的淡底色，--lane-accent 是列标识色
   （列头符号、数字徽章）。用属性值选择器，只命中泳道列，不碰时间轴的行
   （那个钩子没值）。
   待验收用紫色：它是「等 Operator 判断」，跟进行中的琥珀、完成的绿都要拉开。 */
[data-vela-lane="backlog"] { --lane-tint: var(--vela-lane-backlog); --lane-accent: var(--vela-text-3); }
[data-vela-lane="todo"] { --lane-tint: var(--vela-lane-todo); --lane-accent: var(--vela-accent); }
[data-vela-lane="running"] { --lane-tint: var(--vela-lane-running); --lane-accent: var(--vela-warn); }
[data-vela-lane="review"] { --lane-tint: var(--vela-lane-review); --lane-accent: var(--vela-purple); }
[data-vela-lane="done"] { --lane-tint: var(--vela-lane-done); --lane-accent: var(--vela-ok); }
[data-vela-lane="failed"] { --lane-tint: var(--vela-lane-failed); --lane-accent: var(--vela-danger); }

[data-vela-lane-head] {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  padding: 8px 10px;
  /* 不再是一条比泳道暗的实色带——那跟泳道体颜色太接近，看起来像一块贴上去的
     补丁。改成透明，让列头融进泳道自身的淡色里，靠下边框轻轻分开。 */
  background: transparent;
  border-bottom: 1px solid var(--vela-line-soft);
  font-size: 12px;
  font-weight: 600;
  color: var(--vela-text);
  flex: 0 0 auto;
}

/* 列头前面的状态符号，用这一列的标识色。 */
[data-vela-lane-icon] {
  color: var(--lane-accent);
  font-size: 12px;
  line-height: 1;
}

[data-vela-count] {
  font-weight: 600;
  color: var(--lane-accent);
  background: var(--vela-card);
  border-radius: 999px;
  padding: 0 6px;
  min-width: 18px;
  text-align: center;
}

/* 每列内部独立滚动：一列很长时不会把整个看板拉长。 */
[data-vela-lane-body] {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

[data-vela-lane-body]::-webkit-scrollbar { width: 8px; }
[data-vela-lane-body]::-webkit-scrollbar-thumb {
  background: var(--vela-scroll);
  border-radius: 4px;
}
[data-vela-lane-body]::-webkit-scrollbar-thumb:hover {
  background: var(--vela-scroll-hover);
}

[data-vela-empty] {
  color: var(--vela-text-3);
  font-size: 12px;
  text-align: center;
  padding: 14px 6px;
}

/* 拖拽中的合法落点。 */
[data-vela-lane][data-drop='ok'] { border-color: var(--vela-accent); }
[data-vela-lane][data-drop='ok'] [data-vela-lane-body] {
  background: var(--vela-accent-soft);
}
[data-vela-lane][data-drop='no'] { border-color: var(--vela-danger); }

/* ── 卡片 ───────────────────────────────────────────────── */

[data-vela-card] {
  border: 1px solid var(--vela-line-soft);
  border-radius: 7px;
  background: var(--vela-card);
  box-shadow: var(--vela-card-shadow);
  padding: 8px 9px;
  display: flex;
  flex-direction: column;
  gap: 5px;
  cursor: grab;
  transition: border-color 120ms ease;
}

[data-vela-card]:hover { border-color: var(--vela-line); }
[data-vela-card][data-dragging='true'] { opacity: 0.45; cursor: grabbing; }
[data-vela-card]:focus-visible {
  outline: 2px solid var(--vela-accent);
  outline-offset: 1px;
}

/* 编号与标题同一行起排：编号窄且固定，标题吃掉剩下的宽度。 */
[data-vela-card-head] {
  display: flex;
  align-items: baseline;
  gap: 6px;
}

/* 头部右上角的小图标按钮（删除）：安静透明，悬停才露出颜色。特异性要盖过
   面板里通用的 [data-vela-panel] button，所以带上面板前缀。 */
[data-vela-panel] [data-vela-icon-btn] {
  flex: none;
  align-self: flex-start;
  padding: 1px 5px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--vela-text-3);
  font-size: 13px;
  line-height: 1.4;
}

[data-vela-panel] [data-vela-icon-btn]:hover:not(:disabled) {
  background: var(--vela-hover);
  color: var(--vela-text);
}

[data-vela-panel] [data-vela-icon-btn][data-tone='danger']:hover:not(:disabled) {
  background: var(--vela-danger-soft);
  color: var(--vela-danger);
}

[data-vela-number] {
  flex: none;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: .02em;
  color: var(--vela-text-3);
  /* 编号是给人念的句柄，不是可点的控件——别做成链接样子。 */
  user-select: all;
}

[data-vela-card-title] {
  font-weight: 600;
  color: var(--vela-text);
  /* 长标题换行而不是溢出压到别的元素上。 */
  overflow-wrap: anywhere;
}

[data-vela-card-meta] {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 8px;
  font-size: 11px;
  color: var(--vela-text-3);
}

[data-vela-card-meta] code {
  font-family: var(--ds-font-family-code, ui-monospace, monospace);
  overflow-wrap: anywhere;
}

[data-vela-chip] {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 11px;
  border-radius: 4px;
  padding: 0 5px;
  background: var(--vela-canvas);
  border: 1px solid var(--vela-line-soft);
  color: var(--vela-text-2);
}

[data-vela-chip][data-tone='urgent'],
[data-vela-chip][data-tone='high'] {
  background: var(--vela-warn-soft);
  border-color: transparent;
  color: var(--vela-warn);
}

/* 急与高本来同色，在一列卡片里分不出载重。给急加一圈边框与加粗：
   不另开一个色相（那会让四档看起来像四个不同的东西），只把同一色相推得更重。 */
[data-vela-chip][data-tone='urgent'] {
  border-color: var(--vela-warn);
  font-weight: 600;
}

/* 中等：介于默认（无/低）与高之间。没有它的时候四档只有两种颜色。 */
[data-vela-chip][data-tone='medium'] {
  background: var(--vela-info-soft);
  border-color: transparent;
  color: var(--vela-info);
}

[data-vela-failure] {
  font-size: 11px;
  color: var(--vela-danger);
  background: var(--vela-danger-soft);
  border-radius: 4px;
  padding: 4px 6px;
  overflow-wrap: anywhere;
}

[data-vela-actions] {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 2px;
}

/* 操作按钮给一个够得着的点击面；实心主操作吃掉剩余宽度，成为视觉主导。 */
[data-vela-actions] button {
  font-size: 12px;
  padding: 4px 10px;
  min-block-size: 30px;
}

[data-vela-actions] button[data-tone='primary'] {
  flex: 1 1 auto;
}

/* 卡片整卡是抓取手型（可拖），但按钮上悬停必须是指针——
   否则每个按钮都显示成「拖走」，点与不点分不清。 */
[data-vela-card] button {
  cursor: pointer;
}

/* 进行中的卡片：靛蓝描边 + 同色脉动，与主操作色一致 */
[data-vela-card][data-lane='running'] { border-color: var(--vela-accent); }
[data-vela-live] {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--vela-accent);
}
[data-vela-live]::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  animation: vela-pulse 1.4s ease-in-out infinite;
}

@keyframes vela-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.25; }
}

/* ── 表单 ───────────────────────────────────────────────── */

[data-vela-form] {
  display: flex;
  flex-direction: column;
  gap: 5px;
  border: 1px dashed var(--vela-line);
  border-radius: 7px;
  padding: 8px;
  background: var(--vela-card);
}

[data-vela-error] {
  font-size: 11px;
  color: var(--vela-danger);
  overflow-wrap: anywhere;
}

[data-vela-hint] {
  font-size: 11px;
  color: var(--vela-text-3);
}

/* ── 侧栏导航项 ─────────────────────────────────────────── */

[data-vela-nav] {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  font: inherit;
  /* 导航项住在 DSH 的侧栏里，因此背景透明、文字跟随宿主，只有激活态用自己的强调色。 */
  color: inherit;
  background: transparent;
  border: none;
  border-radius: 6px;
  padding: 6px 8px;
  cursor: pointer;
  text-align: left;
}

[data-vela-nav]:hover { background: var(--vela-hover); }
[data-vela-nav][aria-pressed='true'] {
  background: var(--vela-accent-soft);
  color: var(--vela-accent);
  font-weight: 500;
}
[data-vela-nav]:focus-visible {
  outline: 2px solid var(--vela-accent);
  outline-offset: -2px;
}
[data-vela-nav][data-wide='false'] { justify-content: center; padding: 6px 0; }

/* ── 窄屏与降低动效 ─────────────────────────────────────── */

@media (max-width: 720px) {
  /* 窄屏一列一列看：列占大部分可见宽度，横滑看下一列。下限与主规则一致
     （240px），不能比它还低——否则窄窗口反而比宽窗口更挤，那就反了。 */
  [data-vela-grid] { grid-auto-columns: minmax(240px, 84vw); }
}

/* 横向滚动条：六列放不下时它是唯一的线索，不能藏起来。 */
[data-vela-grid]::-webkit-scrollbar { height: 8px; }
[data-vela-grid]::-webkit-scrollbar-thumb {
  background: var(--vela-scroll);
  border-radius: 4px;
}

@media (prefers-reduced-motion: reduce) {
  [data-vela-panel] *,
  [data-vela-live]::before {
    animation: none !important;
    transition: none !important;
  }
}

/* ── 面板主体：左导航 + 右内容 ───────────────────────────── */

/* ── 小队并行时间轴（票 10）─────────────────────── */

[data-vela-timeline] {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin-top: 4px;
  padding-top: 6px;
  border-top: 1px dashed var(--vela-line);
}

[data-vela-timeline-scale] {
  display: flex;
  justify-content: space-between;
  font-size: 10px;
  color: var(--vela-text-3);
  font-variant-numeric: tabular-nums;
}

/* 一条泳道：左标签 / 中间轨道 / 右状态。轨道占剩下的全部宽度，因为
   重叠关系全靠那一段传达。 */
[data-vela-lane] {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
}

[data-vela-panel] button[data-vela-lane-label] {
  all: unset;
  cursor: pointer;
  flex: 0 0 8rem;
  display: flex;
  flex-direction: column;
  font: inherit;
  font-size: 11px;
  text-align: left;
  overflow: hidden;
}

[data-vela-panel] button[data-vela-lane-label]:hover [data-vela-lane-task] {
  text-decoration: underline;
}

[data-vela-panel] button[data-vela-lane-label]:focus-visible {
  outline: 2px solid var(--vela-accent);
  outline-offset: 1px;
}

[data-vela-lane-member] {
  font-weight: 600;
  color: var(--vela-text);
}

/* 任务描述可能很长。单行截断而不换行：泳道高度不齐会让重叠关系变难读。
   完整文本在 title 里。 */
[data-vela-lane-task] {
  color: var(--vela-text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

[data-vela-lane-track] {
  flex: 1 1 auto;
  min-width: 0;
  block-size: 10px;
  border-radius: 5px;
  background: var(--vela-line);
  overflow: hidden;
}

[data-vela-lane-bar] {
  block-size: 100%;
  border-radius: 5px;
  background: var(--vela-text-3);
}

[data-vela-lane][data-tone="ok"] [data-vela-lane-bar] { background: var(--vela-ok); }
[data-vela-lane][data-tone="bad"] [data-vela-lane-bar] { background: var(--vela-danger); }
[data-vela-lane][data-tone="running"] [data-vela-lane-bar] {
  background: var(--vela-accent);
  animation: vela-lane-pulse 1.6s ease-in-out infinite;
}

@keyframes vela-lane-pulse {
  50% { opacity: .55; }
}

[data-vela-lane-status] {
  flex: 0 0 6rem;
  text-align: right;
  color: var(--vela-text-3);
  font-variant-numeric: tabular-nums;
}

[data-vela-timeline-note] {
  margin: 2px 0 0;
  font-size: 10px;
  line-height: 1.4;
  color: var(--vela-text-3);
}

[data-vela-timeline-empty] {
  margin-top: 4px;
  padding-top: 6px;
  border-top: 1px dashed var(--vela-line);
  display: flex;
  flex-direction: column;
  gap: 3px;
}

/* 搜索框（票 11）。它得能伸缩：顶栏里还有 Workspace 筛选与两个按钮。 */
[data-vela-search] {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 1 18rem;
  min-width: 8rem;
}

[data-vela-search] input {
  flex: 1 1 auto;
  min-width: 0;
}

[data-vela-search-hits] {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--vela-text-3);
  font-variant-numeric: tabular-nums;
}

/* 搜索无结果。占整个内容区而不是塞在某一列里：六条空泳道看起来像
   看板被清空了，而那是个令人心惊的误会。 */
[data-vela-no-results] {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 40px 20px;
  text-align: center;
  color: var(--vela-text-2);
}

[data-vela-no-results] p {
  margin: 0;
}

[data-vela-drawer] {
  flex: 0 0 40%;
  min-width: 320px;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-left: 1px solid var(--vela-line);
  background: var(--vela-lane);
  animation: vela-drawer-in .14s ease-out;
}

@keyframes vela-drawer-in {
  from { opacity: 0; transform: translateX(12px); }
  to { opacity: 1; transform: none; }
}

[data-vela-drawer]:focus-visible {
  outline: 2px solid var(--vela-accent);
  outline-offset: -2px;
}

[data-vela-drawer-head] {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--vela-line);
}

[data-vela-drawer-lane] {
  font-size: 11px;
  color: var(--vela-text-2);
}

[data-vela-drawer-body] {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

[data-vela-drawer-label] {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 11px;
  color: var(--vela-text-2);
}

[data-vela-drawer-actions] {
  display: flex;
  gap: 6px;
}

[data-vela-drawer-section] {
  margin: 6px 0 0;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: .04em;
  text-transform: uppercase;
  color: var(--vela-text-3);
}

[data-vela-fields] {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

[data-vela-field] {
  display: flex;
  gap: 8px;
  font-size: 12px;
}

[data-vela-field-label] {
  flex: 0 0 5.5rem;
  color: var(--vela-text-3);
}

[data-vela-field-value] {
  flex: 1 1 auto;
  color: var(--vela-text);
  word-break: break-all;
}

[data-vela-muted] {
  margin: 0;
  font-size: 12px;
  color: var(--vela-text-3);
}

[data-vela-run] {
  padding: 6px 8px;
  border: 1px solid var(--vela-line);
  border-left: 3px solid var(--vela-text-3);
  border-radius: 4px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

[data-vela-run][data-outcome="completed"] { border-left-color: var(--vela-ok); }
[data-vela-run][data-outcome="error"] { border-left-color: var(--vela-danger); }
[data-vela-run][data-outcome="timeout"] { border-left-color: var(--vela-warn); }
[data-vela-run][data-outcome="aborted"] { border-left-color: var(--vela-warn); }
[data-vela-run][data-outcome="running"] { border-left-color: var(--vela-accent); }

[data-vela-run-head] {
  display: flex;
  align-items: center;
  gap: 8px;
}

[data-vela-run-ordinal] {
  font-size: 12px;
  font-weight: 600;
}

[data-vela-run-outcome] {
  font-size: 11px;
  color: var(--vela-text-2);
}

[data-vela-run-failure] {
  margin: 0;
  font-size: 11px;
  color: var(--vela-danger);
  word-break: break-word;
}

[data-vela-card][data-selected="true"] {
  border-color: var(--vela-accent);
  box-shadow: inset 0 0 0 1px var(--vela-accent);
}

[data-vela-panel] button[data-vela-card-title] {
  all: unset;
  cursor: pointer;
  flex: 1 1 auto;
  font: inherit;
  text-align: left;
  color: var(--vela-text);
  word-break: break-word;
}

[data-vela-panel] button[data-vela-card-title]:hover {
  text-decoration: underline;
}

[data-vela-panel] button[data-vela-card-title]:focus-visible {
  outline: 2px solid var(--vela-accent);
  outline-offset: 1px;
}

[data-vela-body] {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
}

[data-vela-sidebar] {
  flex: 0 0 auto;
  width: 176px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 6px;
  overflow-y: auto;
  border-right: 1px solid var(--vela-line);
  background: var(--vela-lane);
}

[data-vela-nav-group] {
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin-bottom: 10px;
}

[data-vela-nav-group-title] {
  padding: 4px 8px 2px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: .08em;
  text-transform: uppercase;
  color: var(--vela-text-3);
}

/* 导航项重置掉面板里通用的按钮样式：它们是列表行，不是控件。 */
[data-vela-panel] [data-vela-nav-item] {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 5px 8px;
  border: 1px solid transparent;
  border-radius: 5px;
  background: transparent;
  color: var(--vela-text-2);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

[data-vela-panel] [data-vela-nav-item]:hover:not(:disabled) {
  background: var(--vela-hover);
  color: var(--vela-text);
}

[data-vela-panel] [data-vela-nav-item][data-active="true"] {
  background: var(--vela-accent-soft);
  border-color: var(--vela-accent);
  color: var(--vela-accent);
  font-weight: 600;
}

/* 置灏项：看得见但明确不可点。悬停提示里写着原因（ADR-0020）。 */
[data-vela-panel] [data-vela-nav-item]:disabled {
  color: var(--vela-text-3);
  opacity: .55;
  cursor: not-allowed;
}

[data-vela-nav-glyph] {
  flex: none;
  width: 15px;
  text-align: center;
  font-size: 12px;
}

[data-vela-nav-label] {
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

[data-vela-nav-badge] {
  flex: none;
  min-width: 17px;
  padding: 0 5px;
  border-radius: 9px;
  background: var(--vela-accent);
  color: var(--vela-accent-text);
  font-size: 10px;
  font-weight: 700;
  line-height: 16px;
  text-align: center;
}

[data-vela-nav-brand] {
  margin-top: auto;
  padding: 6px 8px;
  font-size: 10px;
  color: var(--vela-text-3);
}

[data-vela-notice] {
  padding: 3px 8px;
  border-radius: 5px;
  background: var(--vela-warn-soft);
  color: var(--vela-warn);
  font-size: 11px;
}

/* ── 小队页 ────────────────────────────────────────────── */

[data-vela-squads] {
  flex: 1 1 auto;
  min-width: 0;
  overflow-y: auto;
  padding: 14px 18px;
}

[data-vela-squads] h2 {
  margin: 0;
  font-size: 15px;
}

[data-vela-squads] h3 {
  margin: 0 0 6px;
  font-size: 12px;
  color: var(--vela-text-2);
}

[data-vela-squad-head] {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}

[data-vela-squad-head] h2,
[data-vela-squad-head] h3 {
  flex: 1 1 auto;
}

[data-vela-squad-row] {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 9px 11px;
  margin-bottom: 7px;
  border: 1px solid var(--vela-line-soft);
  border-radius: 7px;
  background: var(--vela-card);
  box-shadow: var(--vela-card-shadow);
}

[data-vela-squad-title] {
  flex: 0 0 auto;
  font-weight: 600;
}

[data-vela-squad-meta] {
  flex: 1 1 auto;
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

[data-vela-squad-editor] {
  max-width: 720px;
}

/* 每个区块自己一张卡：「整支队的设置」与「队员」必须看上去就是两层
   （ADR-0017：沙箱档位是队级的，工具白名单是队员级的）。 */
[data-vela-squad-section] {
  padding: 11px 13px;
  margin: 10px 0;
  border: 1px solid var(--vela-line-soft);
  border-radius: 7px;
  background: var(--vela-card);
}

[data-vela-squad-section="squad"] {
  border-left: 3px solid var(--vela-accent);
}

/* 队员卡：紧凑的四行布局（名字行 / 职责 / 能力 / 白名单小字），
   不再是每个字段独占一行的九层高卡。背景提到卡片色——比页面亮一档，
   与输入框的凹槽底（更深）拉开层次。 */
[data-vela-member] {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 10px 12px;
  margin-bottom: 9px;
  border: 1px solid var(--vela-line-soft);
  border-radius: 8px;
  background: var(--vela-card);
  box-shadow: var(--vela-card-shadow);
}

/* 短字段限宽：名字吃掉剩余宽度，后端与移除按钮挤在行尾。特异性要盖过
   面板里通用的 [data-vela-panel] input { width:100% }，所以从 member-head 选。 */
[data-vela-member-head] {
  display: flex;
  align-items: center;
  gap: 8px;
}

[data-vela-member-head] input {
  flex: 1 1 auto;
  min-width: 0;
  width: auto;
}

[data-vela-member-head] select {
  flex: 0 0 auto;
  width: auto;
}

[data-vela-member-instruction] {
  width: 100%;
}

[data-vela-member-tools] {
  font-size: 11px;
  color: var(--vela-text-3);
  overflow-wrap: anywhere;
}

/* ── 小队界面的质感层 ─────────────────────────────────── */

/* 详情页与创建弹窗里的输入框用凹槽底色：深色界面里输入框要比所在表面
   更深（凹进去），不是更亮——之前输入框与卡片同一个色，整个表单糊成一片。 */
[data-vela-panel] [data-vela-squad-detail] input,
[data-vela-panel] [data-vela-squad-detail] select,
[data-vela-panel] [data-vela-squad-detail] textarea,
[data-vela-panel] [data-vela-modal] input,
[data-vela-panel] [data-vela-modal] textarea {
  background: var(--vela-inset);
}

[data-vela-panel] [data-vela-squad-detail] input:focus,
[data-vela-panel] [data-vela-squad-detail] select:focus,
[data-vela-panel] [data-vela-squad-detail] textarea:focus,
[data-vela-panel] [data-vela-modal] input:focus,
[data-vela-panel] [data-vela-modal] textarea:focus {
  border-color: var(--vela-accent);
}

/* 字母徽：名字的缩略圆。同一个名字永远同一个色（按名字哈希），
   在列表、详情、时间轴里扫一眼就认出「这个人」。 */
[data-vela-avatar] {
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 600;
  color: var(--vela-avatar-text);
  background: var(--vela-avatar-0);
  user-select: none;
}

[data-vela-avatar][data-hue='0'] { background: var(--vela-avatar-0); }
[data-vela-avatar][data-hue='1'] { background: var(--vela-avatar-1); }
[data-vela-avatar][data-hue='2'] { background: var(--vela-avatar-2); }
[data-vela-avatar][data-hue='3'] { background: var(--vela-avatar-3); }
[data-vela-avatar][data-hue='4'] { background: var(--vela-avatar-4); }
[data-vela-avatar][data-hue='5'] { background: var(--vela-avatar-5); }
[data-vela-avatar][data-hue='leader'] { background: var(--vela-accent); }

/* 队长卡：成员列表最前面那张。左边一条 accent 竖条 + 徽章——
   它不是 members 数组里的一条，但界面上它必须可见：小队里「有谁」，
   队长不该隐身。 */
[data-vela-leader] {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 10px 12px;
  margin-bottom: 12px;
  border: 1px solid var(--vela-line-soft);
  border-left: 3px solid var(--vela-accent);
  border-radius: 8px;
  background: var(--vela-card);
  box-shadow: var(--vela-card-shadow);
}

[data-vela-leader-name] {
  font-weight: 600;
  font-size: 13px;
}

[data-vela-leader-badge] {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: .5px;
  padding: 2px 7px;
  border-radius: 999px;
  background: var(--vela-accent-soft);
  color: var(--vela-accent);
}

/* 队长卡里的能力是只读展示（来自基准 preset，这里改不了），
   不要让鼠标悬停给出「可点」的错觉。 */
[data-vela-abilities][data-readonly] [data-vela-ability] span {
  cursor: default;
}

/* 列表行：字母徽 + 主体（标题与标签纵向） + 删除。 */
[data-vela-squad-main] {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

[data-vela-abilities] {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}

/* 能力是可点的 chip：checkbox 视觉隐藏（键盘与语义保留），span 做成 chip。
   选中的实心高亮，没选的描边——一眼看出这个队员能用哪几类。 */
[data-vela-ability] {
  position: relative;
  display: inline-flex;
}

[data-vela-ability] input {
  position: absolute;
  opacity: 0;
  width: 0;
  height: 0;
  margin: 0;
}

[data-vela-ability] span {
  display: inline-block;
  padding: 3px 10px;
  border-radius: 999px;
  border: 1px solid var(--vela-line);
  background: var(--vela-card);
  color: var(--vela-text-2);
  font-size: 12px;
  line-height: 1.4;
  cursor: pointer;
  user-select: none;
}

[data-vela-ability]:hover span {
  border-color: var(--vela-accent);
}

[data-vela-ability][data-on="true"] span {
  background: var(--vela-accent);
  border-color: var(--vela-accent);
  color: var(--vela-accent-text);
  font-weight: 500;
}

[data-vela-ability] input:focus-visible + span {
  outline: 2px solid var(--vela-accent);
  outline-offset: 1px;
}

/* 整支队的设置：几个短字段并排，不再一个占一行。 */
[data-vela-field-row] {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
  align-items: flex-end;
}

[data-vela-field-row] label {
  flex: 0 1 auto;
  margin: 4px 0;
}

[data-vela-field-row] select,
[data-vela-field-row] input {
  width: auto;
  min-width: 0;
}

/* 名册默认折叠成一行，点开才看。 */
[data-vela-roster-fold] {
  margin-top: 6px;
}

[data-vela-roster-fold] summary {
  cursor: pointer;
  font-size: 12px;
  color: var(--vela-text-2);
  user-select: none;
}

[data-vela-roster-fold] summary:hover {
  color: var(--vela-accent);
}

/* 编辑器顶部的小队名字：短输入，不撑满整行。 */
[data-vela-squad-editor] > label > input {
  max-width: 340px;
}

/* 队长实际收到的名册：只读展示，要看得出是自动生成的。 */
[data-vela-roster] {
  margin: 5px 0 0;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--vela-canvas);
  color: var(--vela-text-2);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 190px;
  overflow-y: auto;
}

[data-vela-squads] label {
  display: block;
  margin: 7px 0;
  font-size: 12px;
  color: var(--vela-text-2);
}

[data-vela-squads] textarea {
  resize: vertical;
  font-family: inherit;
}

/* ── 小队：创建弹窗与详情页 ─────────────────────────────── */

/* 遮罩：盖在整个面板上，点外面关闭。 */
[data-vela-modal-backdrop] {
  position: fixed;
  inset: 0;
  z-index: 60;
  background: var(--vela-scrim);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

[data-vela-modal] {
  width: min(560px, 100%);
  max-height: 85vh;
  display: flex;
  flex-direction: column;
  border-radius: 10px;
  border: 1px solid var(--vela-line);
  background: var(--vela-card);
  box-shadow: var(--vela-card-shadow);
}

[data-vela-modal-head] {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--vela-line);
  font-size: 14px;
}

[data-vela-modal-body] {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 14px 16px;
}

[data-vela-modal-field] {
  display: block;
  margin: 10px 0;
  font-size: 12px;
  color: var(--vela-text-2);
}

[data-vela-modal-field] input,
[data-vela-modal-field] textarea {
  margin-top: 4px;
}

[data-vela-modal-foot] {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--vela-line);
}

/* 详情页 */
[data-vela-squad-detail] {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1 1 auto;
  max-width: 760px;
}

[data-vela-detail-head] {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}

[data-vela-back] {
  flex: 0 0 auto;
}

/* 小队名字做成像标题的输入：平时无边框，悬停/聚焦才露出可编辑。特异性盖过通用 input。 */
[data-vela-panel] input[data-vela-detail-title] {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--vela-text);
  border: 1px solid transparent;
  background: transparent;
}

[data-vela-panel] input[data-vela-detail-title]:hover {
  border-color: var(--vela-line);
  background: var(--vela-card);
}

[data-vela-panel] input[data-vela-detail-title]:focus {
  border-color: var(--vela-accent);
  background: var(--vela-card);
}

/* tab 条：按钮做成下划线式，不是通用按钮的卡片样式。特异性盖过 [data-vela-panel] button。 */
[data-vela-tabs] {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--vela-line);
  margin-bottom: 12px;
}

[data-vela-panel] [data-vela-tabs] button {
  border: none;
  background: transparent;
  padding: 7px 12px;
  font-size: 13px;
  color: var(--vela-text-2);
  border-bottom: 2px solid transparent;
  border-radius: 0;
  margin-bottom: -1px;
}

[data-vela-panel] [data-vela-tabs] button:hover:not(:disabled) {
  color: var(--vela-text);
  background: transparent;
}

[data-vela-panel] [data-vela-tabs] button[data-active="true"] {
  color: var(--vela-accent);
  border-bottom-color: var(--vela-accent);
  font-weight: 600;
}

[data-vela-detail-body] {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
}

[data-vela-detail-foot] {
  display: flex;
  gap: 8px;
  padding-top: 12px;
  border-top: 1px solid var(--vela-line);
  margin-top: 12px;
}

/* 小队签：与其余 chip 区分开，一眼看得出这张卡背后是一队而不是一人。 */
[data-vela-chip][data-tone="squad"] {
  border-color: var(--vela-accent);
  background: var(--vela-accent-soft);
  color: var(--vela-accent);
}

/* ── 会话头部的提取入口（票 13）──────────────────────────
 * 这一块长在**宿主自己的**会话头里，不在 Vela 面板里，因此它拿不到
 * [data-vela-panel] 那一层色板。色板的选择器因此得把提取块也包进去（见
 * 开头那两个选择器里的 [data-vela-extract]），否则这里的 var() 全部解不开。
 */
[data-vela-extract-open] {
  font: inherit;
  font-size: 12px;
  padding: 3px 9px;
  border-radius: 6px;
  border: 1px solid var(--vela-line);
  background: var(--vela-card);
  color: var(--vela-text-2);
  cursor: pointer;
}

[data-vela-extract-open]:hover {
  background: var(--vela-hover);
  color: var(--vela-text);
}

[data-vela-extract] {
  width: min(420px, 90vw);
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid var(--vela-line);
  background: var(--vela-card);
  box-shadow: var(--vela-card-shadow);
  font-size: 13px;
  color: var(--vela-text);
}

[data-vela-extract-head] {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

[data-vela-extract-head] button {
  font: inherit;
  font-size: 15px;
  line-height: 1;
  padding: 2px 6px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--vela-text-2);
  cursor: pointer;
}

[data-vela-extract-note] {
  margin: 4px 0;
  font-size: 11px;
  color: var(--vela-text-2);
  /* 路径很长，得允许在任意处折，否则会把弹层撑宽。 */
  overflow-wrap: anywhere;
}

[data-vela-extract-note][data-tone="warn"] { color: var(--vela-warn); }
[data-vela-extract-note][data-tone="bad"] { color: var(--vela-danger); }

[data-vela-extract-empty] {
  padding: 10px 2px;
  font-size: 12px;
  color: var(--vela-text-2);
}

[data-vela-extract-list] {
  list-style: none;
  margin: 6px 0;
  padding: 0;
  /* 候选可能很多（一次长讨论能拿出二三十条），弹层本身不能无限长。 */
  max-height: 46vh;
  overflow-y: auto;
}

[data-vela-extract-list] li { margin: 2px 0; }

[data-vela-extract-list] label {
  display: flex;
  gap: 7px;
  align-items: flex-start;
  padding: 4px 5px;
  border-radius: 6px;
  cursor: pointer;
  /* 标题会很长，换行而不是溢出去压到旁边。 */
  overflow-wrap: anywhere;
}

[data-vela-extract-list] label:hover { background: var(--vela-hover); }

[data-vela-extract-list] input { margin-top: 3px; }

[data-vela-extract-foot] {
  display: flex;
  gap: 7px;
  margin-top: 8px;
}

[data-vela-extract-foot] button {
  font: inherit;
  font-size: 12px;
  padding: 5px 11px;
  border-radius: 7px;
  border: 1px solid var(--vela-line);
  background: var(--vela-card);
  color: var(--vela-text);
  cursor: pointer;
}

[data-vela-extract-create] {
  border-color: transparent !important;
  background: var(--vela-accent) !important;
  /* 要用色板里的强调色字，不能硬写白色：夜间的强调色是亮靛蓝，
     配白字读不清——色板里的 --vela-accent-text 在夜间正是深色。 */
  color: var(--vela-accent-text) !important;
}

[data-vela-extract-foot] button:disabled {
  opacity: .5;
  cursor: not-allowed;
}
`

/**
 * 注入 Vela 的样式并返回撤销函数。重复调用是幂等的（HMR 会重挂 client fiber），
 * 因此以标签上的标识去重。
 */
export function installStyles(doc: Document | undefined): () => void {
  if (doc === undefined) return () => undefined
  const existing = doc.querySelector(`style[data-plugin="${TAG}"]`)
  if (existing !== null) return () => undefined
  const tag = doc.createElement('style')
  tag.setAttribute('data-plugin', TAG)
  tag.textContent = CSS
  doc.head.appendChild(tag)
  return () => { tag.remove() }
}

/** CSS 文本本身，供测试断言关键规则确实在位。 */
export const VELA_CSS = CSS
