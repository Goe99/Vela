/**
 * Vela client half（票 03）。两个 root-scope 的 list slot entry：
 * - `sidebar.footer.action`：导航项，点击切换面板开关。
 * - `shell.overlay`：全幅 Board 面板（ADR-0002）。
 * 两者共享同一个 panel-state 单例，因此点导航项能开合面板。
 *
 * 所有注册、controller、listener 都随 client fiber dispose——绑在
 * ctx.effect 的 disposer 上，HMR 不留泄漏。
 */

import { createElement } from 'react'
import type { VelaClientContext, Dispose } from './dsh-client.ts'
import { createPanelState } from './panel-state.ts'
import type { PanelState } from './panel-state.ts'
import { BoardClient } from './board-client.ts'
import { installStyles } from './styles.ts'
import { BoardNav } from './components/BoardNav.tsx'
import { BoardPanel } from './components/BoardPanel.tsx'

/** 浏览器侧插件名。 */
export const name = 'vela'

/**
 * 需要 slots（注册入口）与 sessions（跳到一次执行的会话）。两者都是 web shell 的
 * 核心服务，官方的十几个 client 插件同样这么声明。
 */
export const inject = ['slots', 'sessions']

/** 该 entry 组件收到的注入面。 */
export interface VelaInjected {
  readonly panel: PanelState
  readonly client: BoardClient
  /**
   * 跳到一次执行的会话并关上看板（ADR-0002 定的动线）。返回 false 表示
   * 这个会话已不在会话列表里（例如被 Operator 删了）。
   */
  readonly openSession: (sessionId: string) => boolean
}

/** 应用 client 插件。 */
export function apply(ctx: VelaClientContext): void {
  ctx.effect(() => {
    const panel = createPanelState()
    // 浏览器 fetch：客户端只在浏览器里跑，globalThis.fetch 必然存在。
    const client = new BoardClient((input, init) => (globalThis as unknown as {
      fetch: (i: string, o?: unknown) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>
    }).fetch(input, init))

    // 跳会话：官方 open() 对未知 id 会 fail loud，所以先对着列表确认。一个 Run
    // 的会话可能已被 Operator 删掉，那时宁可不跳也不能把应用搞崩。
    const openSession = (sessionId: string): boolean => {
      const ids = ctx.sessions.list?.get?.()?.ids
      if (ids !== undefined && !ids.includes(sessionId)) return false
      try {
        ctx.sessions.open(sessionId)
        panel.close()
        return true
      } catch {
        return false
      }
    }

    const injected: VelaInjected = { panel, client, openSession }

    // 样式随 fiber 注入与摘除，HMR 不累积重复的 style 标签。
    const disposeStyles = installStyles(
      (globalThis as { document?: Document }).document,
    )

    const disposers: Dispose[] = []
    ctx.slots.inject('sidebar.footer.action', () => {
      const dispose = ctx.slots.register(
        { name: 'sidebar.footer.action', id: 'vela-nav', order: 20, inject: () => injected },
        BoardNav,
      )
      disposers.push(dispose)
      return dispose
    })
    ctx.slots.inject('shell.overlay', () => {
      const dispose = ctx.slots.register(
        { name: 'shell.overlay', id: 'vela-board', order: 20, inject: () => injected },
        BoardPanel,
      )
      disposers.push(dispose)
      return dispose
    })

    return () => {
      for (const dispose of disposers) dispose()
      disposeStyles()
    }
  }, 'vela: sidebar nav + board overlay')
}
