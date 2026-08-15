/**
 * Vela client half 触及的浏览器侧 DSH 表面，同样用结构化最小接口而非
 * 从 @deepseek-ai/dsh-client-* 导入（理由见 src/dsh.ts）。这些包在
 * client bundle 里是 external，运行时由平台模块表提供。
 */

/** 一个 disposer。 */
export type Dispose = () => void

/** 一个 slot 注册项。字段是官方 register options 的子集。 */
export interface SlotRegistration {
  readonly name: string
  readonly id: string
  readonly order?: number
  /** 该 entry 的注入面工厂：返回给组件的业务对象。 */
  readonly inject?: () => unknown
}

/** 浏览器侧 slots 服务。 */
export interface SlotsService {
  /** 等目标 slot 被其 owner 声明后执行回调（声明与注册次序不保证）。 */
  inject(slotKey: string, register: () => Dispose): void
  /** 向一个已声明的 slot 注册一个 entry + 组件。返回 disposer。 */
  register(options: SlotRegistration, component: unknown): Dispose
}

/**
 * 浏览器侧会话服务中 Vela 用到的部分。它同时是该应用的导航状态：`open`
 * 把一个会话选为当前。官方文档明说未知 id 会 fail loud，因此调用前必须先
 * 确认它在列表里。
 */
export interface SessionsNav {
  open(id: string): void
  /** 列表快照。形状取官方 ObservableSnapshot 的最小子集。 */
  readonly list?: { get?(): { ids?: readonly string[] } | undefined }
}

/** 浏览器侧 client 上下文中 Vela 用到的部分。 */
export interface VelaClientContext {
  effect(setup: () => Dispose, label?: string): Dispose
  readonly slots: SlotsService
  /**
   * 会话导航。必须列入 `inject` 才能拿到——官方的十几个 client 插件
   * （sidebar、jobs、workspace 等）同样如此，web shell 里它必然存在。
   */
  readonly sessions: SessionsNav
}
