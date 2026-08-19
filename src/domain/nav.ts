/**
 * 左侧导航的模型（ADR-0020）。按 Multica 的三组十二项原样摆好，但每一项背后
 * 是三种**真存在**的动作之一，或者一个说明了原因的置灰位。
 *
 * 为什么是一份纯数据而不是散在组件里：ADR-0020 要求「十二项每一项都有明确
 * 归属，没有一项悬空」可被测试锁住。把归属写成数据，那条测试就是一句遍历；
 * 散在 JSX 里就只能靠人眼数。
 *
 * ## 这里没有「跳转到某个 DSH 页面」
 *
 * 对着实际安装的运行时查过：DSH 不给第三方插件任何页面导航能力（没有 router，
 * `ctx.layout` 只改面板几何）。设置页是一堆插槽而非可导航目标。技能页 DSH 也
 * 没有——所以「技能」是 Vela **自己画**的第四个视图（技能广场），而不是跳转。
 * 可用的动作只有下面这四种。
 */

/** 一项导航背后到底发生什么。 */
export type NavAction =
  /** 切到 Vela 自己的某个视图。 */
  | { readonly kind: 'view'; readonly view: NavView }
  /** 关掉 Vela 面板，露出下面 DSH 自己的界面。 */
  | { readonly kind: 'close-panel' }
  /** 调 DSH 的 openDocument，把对应配置文件交给系统编辑器。 */
  | { readonly kind: 'open-document'; readonly target: DocumentTarget }
  /**
   * 置灰位。`reason` 区分两种完全不同的情况，提示文案不能混：
   * `not-yet` = 我们还没做（下一期）；`no-such-page` = DSH 没有这个页面可去。
   */
  | { readonly kind: 'disabled'; readonly reason: 'not-yet' | 'no-such-page'; readonly note: string }

/** Vela 自己画的视图。 */
export type NavView = 'board' | 'attention' | 'squads' | 'skills' | 'memory'

/** 可交给 DSH 打开的配置文件。 */
export type DocumentTarget = 'settings' | 'agent-presets'

/** 全部可打开的配置文件。 */
export const DOCUMENT_TARGETS: readonly DocumentTarget[] = ['settings', 'agent-presets']

/** 导航的一个分组。 */
export type NavGroup = 'personal' | 'workspace' | 'configure'

/** 分组标题，按 Multica 的分法。 */
export const NAV_GROUP_LABELS: Readonly<Record<NavGroup, string>> = {
  personal: '个人',
  workspace: '工作区',
  configure: '配置',
}

/** 分组的展示顺序。 */
export const NAV_GROUPS: readonly NavGroup[] = ['personal', 'workspace', 'configure']

/** 一项导航。 */
export interface NavItem {
  /** 稳定的键，用于高亮与测试。沿用 Multica 的键名，方便对照。 */
  readonly key: string
  readonly group: NavGroup
  readonly label: string
  readonly action: NavAction
  /** 徽标取自哪个计数；缺省表示这一项没有徽标。 */
  readonly badge?: 'attention'
}

/**
 * 十二项导航，顺序与分组与 Multica 一致。
 *
 * `inbox` 是唯一一处**换掉语义**而不是接过来的：DSH 没有收件箱，而 Multica 的
 * Inbox 语义（别人给你发消息）在单 Operator 的世界里不存在（ADR-0001）。空着
 * 一格不如换成这个位置真正该有的东西——需要你动手的卡有多少张。
 */
export const NAV_ITEMS: readonly NavItem[] = [
  {
    key: 'inbox',
    group: 'personal',
    label: '待你处理',
    action: { kind: 'view', view: 'attention' },
    badge: 'attention',
  },
  {
    key: 'chat',
    group: 'personal',
    label: '聊天',
    action: { kind: 'close-panel' },
  },
  {
    key: 'myIssues',
    group: 'personal',
    label: '我的任务',
    action: { kind: 'view', view: 'board' },
  },
  {
    key: 'issues',
    group: 'workspace',
    label: '任务',
    action: { kind: 'view', view: 'board' },
  },
  {
    key: 'projects',
    group: 'workspace',
    label: '项目',
    action: { kind: 'disabled', reason: 'not-yet', note: '下一期：比 Workspace 更粗的一层归组' },
  },
  {
    key: 'autopilots',
    group: 'workspace',
    label: '自动化',
    action: { kind: 'disabled', reason: 'not-yet', note: '下一期：按规则自动派活' },
  },
  {
    key: 'agents',
    group: 'workspace',
    label: 'Agent 配置',
    action: { kind: 'open-document', target: 'agent-presets' },
  },
  {
    key: 'squads',
    group: 'workspace',
    label: '小队',
    action: { kind: 'view', view: 'squads' },
  },
  {
    key: 'memory',
    group: 'workspace',
    label: '记忆',
    // 第十三项：打破了「按 Multica 的十二项原样摆好」（ADR-0024）。破例的理由是
    // 记忆库在 DSH 里根本不存在，不属于 ADR-0020 要防的「重画 DSH 已有界面」。
    action: { kind: 'view', view: 'memory' },
  },
  {
    key: 'usage',
    group: 'workspace',
    label: '用量',
    action: { kind: 'disabled', reason: 'not-yet', note: '下一期：跨卡与跨小队的用量汇总' },
  },
  {
    key: 'runtimes',
    group: 'configure',
    label: '运行时',
    action: { kind: 'open-document', target: 'settings' },
  },
  {
    key: 'skills',
    group: 'configure',
    label: '技能',
    // DSH 没有技能页面（技能是渲在对话里的），所以 Vela 自己画一个只读的
    // 技能广场：这个部署装了哪些技能，一眼能看到。
    action: { kind: 'view', view: 'skills' },
  },
  {
    key: 'settings',
    group: 'configure',
    label: '设置',
    action: { kind: 'open-document', target: 'settings' },
  },
]

/** 某个分组下的导航项，按声明顺序。 */
export function itemsInGroup(group: NavGroup): readonly NavItem[] {
  return NAV_ITEMS.filter(item => item.group === group)
}

/** 点某一项时应该切到哪个视图；不是视图类动作则返回 undefined。 */
export function viewFor(item: NavItem): NavView | undefined {
  return item.action.kind === 'view' ? item.action.view : undefined
}
