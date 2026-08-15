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
[data-vela-nav] {
  /* 画布：面板底色，比泳道暗一档，让泳道浮出来 */
  --vela-canvas: #eef1f6;
  /* 泳道底色 */
  --vela-lane: #f7f9fc;
  /* 泳道标题带：比泳道体再暗一点，让每列有个"头" */
  --vela-lane-head: #edf1f7;
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
  --vela-danger: #d33a4b;
  --vela-danger-soft: #fdeff1;
  --vela-warn: #a55a00;
  --vela-warn-soft: #fff4e0;
  --vela-hover: #e6ecf5;
  --vela-card-shadow: 0 1px 2px rgba(21, 44, 92, .07), 0 1px 3px rgba(21, 44, 92, .05);
  --vela-scroll: #c9d4e5;
  --vela-scroll-hover: #adbdd4;
}

/* ── 色板：夜间 ─────────────────────────────────────────────
   只覆盖同一组变量；下面所有规则都不再关心明暗。
   ───────────────────────────────────────────────────────── */
body[data-ds-dark-theme] [data-vela-panel],
body[data-ds-dark-theme] [data-vela-nav] {
  --vela-canvas: #101319;
  --vela-lane: #171b23;
  --vela-lane-head: #1c212b;
  --vela-card: #212734;
  --vela-line: #313a4b;
  --vela-line-soft: #272e3b;
  --vela-text: #e6ecf5;
  --vela-text-2: #a3b0c4;
  --vela-text-3: #7a879b;
  --vela-accent: #5b7cf7;
  --vela-accent-hover: #7290fa;
  --vela-accent-text: #0b0e13;
  --vela-accent-soft: #1e2740;
  --vela-danger: #ff7f88;
  --vela-danger-soft: #2c1b20;
  --vela-warn: #f0b959;
  --vela-warn-soft: #372a15;
  --vela-hover: #272e3b;
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
   * 六列等宽。最小列宽必须让六列在常见窗口里**一次放下**——「一眼看全」是这个
   * 看板的全部意义，一旦第六列被挤出屏幕，Failed 里的卡片就等于不存在。
   * 176px × 6 + 间距 + 内边距 ≈ 1116px，覆盖 1152 及更宽的窗口；更窄时才横向
   * 滚动，而不是把列压到读不了。
   */
  grid-auto-flow: column;
  grid-auto-columns: minmax(176px, 1fr);
  gap: 8px;
  padding: 10px;
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
  background: var(--vela-lane);
  overflow: hidden;
}

[data-vela-lane-head] {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  padding: 8px 10px;
  background: var(--vela-lane-head);
  border-bottom: 1px solid var(--vela-line-soft);
  font-size: 12px;
  font-weight: 600;
  color: var(--vela-text-2);
  flex: 0 0 auto;
}

[data-vela-count] {
  font-weight: 400;
  color: var(--vela-text-3);
  background: var(--vela-canvas);
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
  gap: 4px;
  margin-top: 1px;
}

[data-vela-actions] button { font-size: 12px; padding: 2px 8px; }

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
  [data-vela-grid] { grid-auto-columns: minmax(200px, 84vw); }
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
