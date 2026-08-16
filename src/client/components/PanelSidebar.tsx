/**
 * 面板内的左侧导航（票 03 / ADR-0020）。按 Multica 的三组十二项摆开。
 *
 * 归属表本身在 `domain/nav.ts` 里，是一份纯数据——这里只负责把它画出来并把
 * 点击派给对应的动作。**没有任何一项是「跳到 DSH 的某个页面」**：DSH 不给
 * 第三方插件页面导航（见 ADR-0020 的取证一节）。
 */

import { createElement } from 'react'
import type { NavItem, NavView } from '../../domain/nav.ts'
import { NAV_GROUPS, NAV_GROUP_LABELS, NAV_ITEMS, itemsInGroup } from '../../domain/nav.ts'
import type { DocumentTarget } from '../../domain/nav.ts'

/** 侧栏的 props。 */
export interface PanelSidebarProps {
  readonly current: NavView
  /** 「待你处理」的徽标数字：待验收 + 失败的卡数。为 0 时不显示徽标。 */
  readonly attention: number
  onSelect(view: NavView): void
  /** 关掉整个面板，露出下面 DSH 自己的界面。 */
  onClosePanel(): void
  /** 把一份 DSH 配置文件交给系统编辑器。 */
  onOpenDocument(target: DocumentTarget): void
}

/** 每项前面的小记号。刻意用字符而不是图标字体，免得多一份资源依赖。 */
const GLYPHS: Readonly<Record<string, string>> = {
  inbox: '◍',
  chat: '💬',
  myIssues: '◑',
  issues: '▦',
  projects: '❏',
  autopilots: '⟳',
  agents: '⌬',
  squads: '⚑',
  usage: '◴',
  runtimes: '⚙',
  skills: '✦',
  settings: '⚙',
}

function renderItem(item: NavItem, props: PanelSidebarProps): ReturnType<typeof createElement> {
  const { action } = item
  const isDisabled = action.kind === 'disabled'
  const active = action.kind === 'view' && action.view === props.current
  const badge = item.badge === 'attention' && props.attention > 0 ? props.attention : undefined

  const onClick = (): void => {
    switch (action.kind) {
      case 'view':
        props.onSelect(action.view)
        return
      case 'close-panel':
        props.onClosePanel()
        return
      case 'open-document':
        props.onOpenDocument(action.target)
        return
      case 'disabled':
        // 置灰项点了什么也不做。按钮本身 disabled，这里只是兜底。
        return
    }
  }

  return createElement(
    'button',
    {
      key: item.key,
      type: 'button',
      disabled: isDisabled,
      onClick,
      'data-vela-nav-item': item.key,
      'data-active': String(active),
      // 置灰的两种原因分开标注：Operator 要能区分「还没做」与「dsh 没这地方」。
      ...(isDisabled ? { 'data-disabled-reason': action.reason } : {}),
      title: isDisabled ? action.note : item.label,
      'aria-current': active ? 'page' : undefined,
    },
    createElement('span', { 'data-vela-nav-glyph': '', 'aria-hidden': 'true' }, GLYPHS[item.key] ?? '·'),
    createElement('span', { 'data-vela-nav-label': '' }, item.label),
    ...(badge === undefined
      ? []
      : [createElement('span', { key: 'badge', 'data-vela-nav-badge': '' }, String(badge))]),
  )
}

/** 面板内的左侧导航。 */
export function PanelSidebar(props: PanelSidebarProps): ReturnType<typeof createElement> {
  return createElement(
    'nav',
    { 'data-vela-sidebar': '', 'aria-label': 'Vela 导航' },
    ...NAV_GROUPS.map(group => createElement(
      'div',
      { key: group, 'data-vela-nav-group': group },
      createElement('div', { 'data-vela-nav-group-title': '' }, NAV_GROUP_LABELS[group]),
      ...itemsInGroup(group).map(item => renderItem(item, props)),
    )),
    // Multica License 条件 (b)：移植的看板 UI 必须保留 Multica 署名。
    createElement('div', { 'data-vela-nav-brand': '' }, 'Powered by Multica'),
  )
}

/** 导出给测试用的项数，避免测试自己再数一遍。 */
export const NAV_ITEM_COUNT = NAV_ITEMS.length
