/**
 * Vela 触及的 DSH 表面，用**结构化最小接口**声明而非从 @deepseek-ai/*
 * 导入。理由有两条：
 *
 * 1. dsh 处于 developer preview、无兼容承诺，且实际运行时的包（rc.6，
 *    捆绑在 dsh 安装内）与 npm 上独立发布的那条线版本不一致。依赖具体
 *    类型包会让 Vela 绑死在一个可能对不上的版本上。
 * 2. 这是官方对第三方插件的既有做法——已验证可用的外部插件同样只声明
 *    自己实际调用的那几个方法。
 *
 * 代价是编译器不再替我们校验与 harness 的契约：这里的每个签名都必须
 * 对着真实运行时取证过，改动时同样。
 */

/** 一个 disposer。 */
export type Dispose = () => void | Promise<void>

/** HTTP 路由的匹配方式。 */
export type RouteKind = 'exact' | 'prefix'

/** Node 原生请求中 Vela 实际用到的部分。 */
export interface HttpRequest {
  readonly url?: string
  readonly method?: string
  on(event: 'data', listener: (chunk: Buffer) => void): unknown
  on(event: 'end', listener: () => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
}

/** Node 原生响应中 Vela 实际用到的部分。 */
export interface HttpResponse {
  statusCode: number
  setHeader(name: string, value: string): unknown
  end(body?: string): unknown
}

/** 宿主 web server 服务。 */
export interface WebServerLike {
  register(route: {
    readonly kind: RouteKind
    readonly path: string
    readonly handler: (req: HttpRequest, res: HttpResponse) => void | Promise<void>
  }): Dispose
}

/**
 * 官方 RPC 信封。宿主的 apiProxy 是「传输无关的网关面」，因此进程内直接
 * 调用与浏览器经 HTTP 调用走的是同一份实现——Vela 派活因此完全复用官方
 * 的开会话逻辑，不复制任何消息结构。
 */
export interface RpcRequest<P> {
  readonly rpcId: string
  readonly payload: P
}

/** 官方 RPC 结果。 */
export type RpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

/** 官方 RPC 回复信封。 */
export interface RpcResponse<T> {
  readonly rpcId: string
  readonly result: RpcResult<T>
}

/** apiProxy 的会话域中 Vela 实际用到的方法。 */
export interface SessionsApiLike {
  /** 创建一个真实会话**及其空闲 agent**。省略 sessionId 则由宿主分配。 */
  create(request: RpcRequest<{ cwd?: string; sessionId?: string; agentPreset?: string }>):
  Promise<RpcResponse<{ sessionId: string; agentPreset?: string }>>
  /** 改标题：追加一条 user 来源的 session/title，会钉住不被自动改写。 */
  rename(request: RpcRequest<{ sessionId: string; title: string }>):
  Promise<RpcResponse<{ title: string; seq: number }>>
  /** 提交一条消息。content 是 core 的 ContentBlock[] 原样。 */
  prompt(request: RpcRequest<{
    sessionId: string
    mode: 'queue' | 'steer'
    content: readonly { readonly type: 'text'; readonly text: string }[]
  }>): Promise<RpcResponse<{ accepted: true }>>
  /** 停掉一个会话正在进行的 turn。 */
  cancel(request: RpcRequest<{ sessionId: string }>): Promise<RpcResponse<{ accepted: true }>>
}

/** 宿主 apiProxy 服务中 Vela 实际用到的部分。 */
export interface ApiProxyLike {
  readonly sessions: SessionsApiLike
}

/**
 * 一个 DSH 会话。Vela 只把它当作不透明句柄传给 permissionPresets，不读
 * 它的内部结构。
 */
export interface SessionHandle {
  readonly header?: { readonly id?: string; readonly cwd?: string }
}

/** 会话仓库中 Vela 实际用到的部分。 */
export interface SessionStoreLike {
  get(id: string): SessionHandle | undefined
}

/**
 * 权限档位服务（票 02 的答案）。档位不是创建会话时的参数——它由这个服务
 * 写入会话的 knob 事件。`set` 接的是 preset **名字**而非 sandbox 取值：
 * 默认表里两者恰好同名（workspace-write / danger-full-access），但部署
 * 可以改表，因此 Vela 配置的是名字并对着 `names` 校验。
 */
export interface PermissionPresetsLike {
  /** 可切换的 preset 名字，按声明顺序。 */
  readonly names: readonly string[]
  /** 记录并施加一个 preset；未知名字会抛错。 */
  set(session: SessionHandle, name: string): void
}

/**
 * 一条会话事件。Vela 只关心两类：assistant/message 带 token 用量，
 * turn/end 宣布一次执行结束。其余原样忽略。
 */
export interface SessionEventLike {
  readonly seq: number
  readonly type: string
  readonly data?: unknown
}

/** Cordis 上下文中 Vela 实际用到的部分。 */
export interface VelaContext {
  /**
   * 把一个副作用绑到当前 fiber：返回的 disposer 在插件卸载时被调用。
   * 所有长生命周期资源都必须经由它，否则 HMR 会留下泄漏。
   */
  effect(setup: () => Dispose, label?: string): Dispose
  /** 订阅一个 Cordis 事件；返回取消订阅。 */
  on(event: 'session/event', listener: (session: unknown, event: SessionEventLike) => void): Dispose
  /** 取一个可选 service；未挂载时返回 undefined。 */
  get(name: 'apiProxy'): ApiProxyLike | undefined
  get(name: 'permissionPresets'): PermissionPresetsLike | undefined
  get(name: 'sessions'): SessionStoreLike | undefined
  readonly webServer?: WebServerLike
  readonly logger?: {
    warn(message: unknown): void
    info(message: unknown): void
  }
}
