/**
 * Board 面板的开关状态（票 03）。导航项（在 sidebar）与面板（在
 * shell.overlay）是两个独立的 slot entry，但共享同一份「是否打开」——
 * 因此这份状态必须活在两个组件之外的单例里，并可订阅。
 *
 * 纯逻辑、零 DOM、零 React：好在 node 里直接测。
 */

/** Board 面板的开关状态与操作。 */
export interface PanelState {
  isOpen(): boolean
  open(): void
  close(): void
  toggle(): void
  /** 订阅变化；返回取消订阅。 */
  subscribe(listener: () => void): () => void
}

/** 建一个开关 store。 */
export function createPanelState(): PanelState {
  let open = false
  const listeners = new Set<() => void>()
  const emit = (): void => {
    for (const listener of [...listeners]) listener()
  }
  const set = (next: boolean): void => {
    if (next === open) return
    open = next
    emit()
  }
  return {
    isOpen: () => open,
    open: () => set(true),
    close: () => set(false),
    toggle: () => set(!open),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}
