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
 * 会话列表里一行的形状。取官方 `SessionsPortSummary` 的最小子集。
 *
 * `cwd` 就是那个会话被创建时的工作目录——票 13 靠它把提取出的卡
 * 默认落到同一个仓库上。它是可选的：官方注释说「未记录时缺席」。
 */
export interface SessionRow {
  readonly id: string
  readonly cwd?: string
}

/**
 * 浏览器侧会话服务中 Vela 用到的部分。它同时是该应用的导航状态：`open`
 * 把一个会话选为当前。官方文档明说未知 id 会 fail loud，因此调用前必须先
 * 确认它在列表里。
 */
export interface SessionsNav {
  open(id: string): void
  /** 列表快照。形状取官方 ObservableSnapshot 的最小子集。 */
  readonly list?: {
    get?(): {
      ids?: readonly string[]
      /** 按 id 索引的行，工作目录就在这里。 */
      byId?: Readonly<Record<string, SessionRow | undefined>>
    } | undefined
  }
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

/**
 * 一段已完成的消息内容块。DSH 的消息不是纯字符串，而是内容块数组（文本、
 * 图片、工具调用……）。提取待办只关心文本那一种。
 */
export interface TextBlock {
  readonly kind?: string
  readonly type?: string
  readonly text?: string
}

/**
 * 会话里的一个节点。取官方 `ConversationNode` 的最小子集：用户消息把文本放在
 * `content` 里，助手消息放在 `blocks` 里——两个字段名不同，但里面都是块。
 */
export interface ConversationNodeLike {
  readonly kind: string
  readonly content?: readonly TextBlock[]
  readonly blocks?: readonly TextBlock[]
}

/**
 * 会话快照中 Vela 用到的部分。
 *
 * `hasMore` 很重要：`nodes` 只盖当前已加载的那一扇窗口，更早的历史需要滚回去
 * 才会拉。客户端没有能直接读完整历史的接口，所以提取必须把这个限制告诉
 * Operator，而不是默默少捞几条。
 */
export interface ConversationSnapshotLike {
  readonly nodes?: readonly ConversationNodeLike[]
  /** 还有更早的历史没加载。 */
  readonly hasMore?: boolean
}

/**
 * 挂在会话作用域 slot 上的组件从框架拿到的标准 props。
 *
 * 这两个是框架**自动**注入的（官方叫 SessionStandardProps），不靠我们自己的
 * `inject` 传——也因此只在会话作用域的 slot 里存在。
 */
export interface SessionSlotProps {
  readonly sessionId: string
  readonly useSession: <T>(select: (snapshot: ConversationSnapshotLike) => T) => T
}
