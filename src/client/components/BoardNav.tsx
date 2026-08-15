/**
 * sidebar 页脚的导航项（票 03）。点击切换 Board 面板；订阅 panel-state 让激活
 * 态实时反映面板开合。宽态显示文字，折叠态只留图标。
 *
 * 注入面是**直接铺平到 props 上**的（框架的 SlotInjectFace 把 inject 工厂的
 * 返回值展开进 props），不套在 props.inject 里。
 */

import { createElement, useSyncExternalStore } from 'react'
import type { VelaInjected } from '../index.ts'

/** 导航项的 props：注入面 + owner 在 renderSlot 处传的布局参数。 */
export type BoardNavProps = VelaInjected & {
  /** sidebar 是否处于宽态；折叠态为 false。 */
  readonly wide?: boolean
}

/** 导航项组件。 */
export function BoardNav(props: BoardNavProps): ReturnType<typeof createElement> {
  const { panel } = props
  const isOpen = useSyncExternalStore(
    listener => panel.subscribe(listener),
    () => panel.isOpen(),
    () => panel.isOpen(),
  )
  const wide = props.wide ?? true
  return createElement(
    'button',
    {
      type: 'button',
      onClick: () => panel.toggle(),
      'data-vela-nav': '',
      'data-wide': String(wide),
      'aria-pressed': isOpen,
      // 折叠态没有文字，必须靠这个说明用途。
      'aria-label': 'Vela board',
      title: wide ? undefined : 'Vela board',
    },
    createElement('span', { 'aria-hidden': 'true' }, '▦'),
    ...(wide ? [createElement('span', { key: 'label' }, 'Vela')] : []),
  )
}
