/**
 * 浏览器侧 Board API 客户端。轮询用 no-store + in-flight guard + 响应形状校验；
 * 失败保留最后一次成功快照，不把界面清空。
 *
 * fetch 经构造注入，因此可在 node 里用 fake 直接测这套取数/守卫逻辑，不需要
 * 真的网络。
 */

import { API_PREFIX } from '../http/contract.ts'
import type { Board, TokenUsage } from '../domain/types.ts'
import { BOARD_VERSION, emptyBoard } from '../domain/types.ts'
import type { Squad } from '../domain/squad.ts'
import type { MemberSpan } from '../domain/timeline.ts'
import type { DocumentTarget } from '../domain/nav.ts'

/** 最小 fetch 形状——只声明这里用到的部分。 */
export type FetchLike = (input: string, init?: {
  method?: string
  headers?: Record<string, string>
  body?: string
}) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
}>

/**
 * 服务端给出的完整视图：快照本身，加上三项不属于快照的运行时事实。
 * 后三项刷新即变，故不写进 Board。
 */
export interface BoardView {
  readonly board: Board
  /** 在途 Run 的实时用量，按 Issue 索引。 */
  readonly liveUsage: Readonly<Record<string, TokenUsage>>
  /** 这个部署提供的权限 preset 名字。 */
  readonly sandboxPresets: readonly string[]
  /** 这个部署是否具备派活能力。 */
  readonly canDispatch: boolean
  /** 可选的小队，派活时的下拉靠它。 */
  readonly squads: readonly SquadShape[]
  /** 这个部署能不能管理小队（没有可写 preset 根时为 false）。 */
  readonly canManageSquads: boolean
  /**
   * 部署所在平台。小队编辑器靠它把「跑命令」展开成真实工具名——浏览器
   * 里没有 `process`，这个事实只能由宿主告知。
   */
  readonly platform: string
  /**
   * 小队并行时间轴，按**会话 id** 索引（ADR-0019）。拿 Run 的 sessionId 去查。
   *
   * 只包含真的有泳道的会话，因此「没有这个键」与「有这个键但数组为空」是两回事：
   * 前者是「不是小队 Run」，后者不会出现。
   */
  readonly timelines?: Readonly<Record<string, readonly MemberSpan[]>>
  /**
   * 每张卡此刻在跑的队员名单，按 issue id 索引。没有这个键 = 没有队员在跑。
   * 后端从时间轴记录器算出（ADR-0019），前端直接显示，不自己算。
   */
  readonly liveMembers?: Readonly<Record<string, readonly string[]>>
}

/**
 * 一支小队在浏览器侧的形状：定义本身加上队长实际收到的完整职责说明
 * （后者含自动追加的队员名册，编辑器里只读展示）。
 */
export type SquadShape = Squad & { readonly resolvedInstruction?: string }

/** 一次写操作的结果。 */
export type MutationResult =
  | { readonly ok: true; readonly view: BoardView }
  | { readonly ok: false; readonly status: number; readonly message: string }

function isBoard(value: unknown): value is Board {
  return typeof value === 'object' && value !== null
    && (value as { version?: unknown }).version === BOARD_VERSION
    && Array.isArray((value as { issues?: unknown }).issues)
}

function readUsageMap(value: unknown): Readonly<Record<string, TokenUsage>> {
  if (typeof value !== 'object' || value === null) return {}
  return value as Record<string, TokenUsage>
}

function readStrings(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function readSquads(value: unknown): readonly SquadShape[] {
  return Array.isArray(value) ? (value as SquadShape[]) : []
}

/** 时间轴与在跑名单是「会话 id → 数组」的映射。逐项校验太重——，这里做的是
 * 「形状是对象就透传」——泳道内部形状由时间轴组件自己面对。 */
function readTimelines(value: unknown): Readonly<Record<string, readonly MemberSpan[]>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const out: Record<string, readonly MemberSpan[]> = {}
  for (const [key, spans] of Object.entries(value)) {
    if (Array.isArray(spans)) out[key] = spans as readonly MemberSpan[]
  }
  return out
}

function readLiveMembers(value: unknown): Readonly<Record<string, readonly string[]>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const out: Record<string, readonly string[]> = {}
  for (const [key, names] of Object.entries(value)) {
    if (Array.isArray(names)) out[key] = names.filter((n): n is string => typeof n === 'string')
  }
  return out
}

/** 从一个未经校验的响应体里读出视图；形状不对则 undefined。 */
function readView(body: unknown): BoardView | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const raw = body as Record<string, unknown>
  if (!isBoard(raw.board)) return undefined
  return {
    board: raw.board,
    liveUsage: readUsageMap(raw.liveUsage),
    sandboxPresets: readStrings(raw.sandboxPresets),
    canDispatch: raw.canDispatch === true,
    squads: readSquads(raw.squads),
    canManageSquads: raw.canManageSquads === true,
    // 读不到时回落到 linux 而不是报错：这只影响编辑器里展示的工具名，
    // 真正写盘的那份由宿主用自己的平台生成，不靠这个值。
    platform: typeof raw.platform === 'string' ? raw.platform : 'linux',
    // 时间轴与在跑队员：服务端发出什么就透传什么。这两个字段缺失过一次——
    // 类型里声明了、服务端发了，唯独这里没抄，于是抽屉的时间轴永远不渲染、
    // 卡片的「谁在跑」永远不显示。单元测试全是直接构造 props，根本不过这里，
    // 所以这条接缝必须由 board-client 自己的测试钉住。
    timelines: readTimelines(raw.timelines),
    liveMembers: readLiveMembers(raw.liveMembers),
  }
}

const EMPTY: BoardView = {
  board: emptyBoard(),
  liveUsage: {},
  sandboxPresets: [],
  canDispatch: false,
  squads: [],
  canManageSquads: false,
  platform: 'linux',
}

/** Board 的浏览器侧客户端。 */
export class BoardClient {
  /** 最后一次成功读到的视图——刷新失败时界面回退到它而不是空白。 */
  private last: BoardView | undefined
  /** 轮询在途标志：一次没回来前不发下一次，避免请求堆叠。 */
  private inFlight = false

  constructor(private readonly fetch: FetchLike) {}

  /** 最后一次成功视图；从未成功过则 undefined。 */
  get snapshot(): BoardView | undefined {
    return this.last
  }

  /**
   * 拉取最新视图。已有请求在途时跳过本次（返回上次视图）。响应形状不对或
   * 请求失败时保留上次视图。
   */
  async refresh(): Promise<BoardView | undefined> {
    if (this.inFlight) return this.last
    this.inFlight = true
    try {
      const response = await this.fetch(`${API_PREFIX}/board`, {
        method: 'GET',
        headers: { 'cache-control': 'no-store' },
      })
      if (!response.ok) return this.last
      const view = readView(await response.json())
      if (view === undefined) return this.last
      this.last = view
      return view
    } catch {
      return this.last
    } finally {
      this.inFlight = false
    }
  }

  private async write(path: string, method: string, payload?: unknown): Promise<MutationResult> {
    let response: Awaited<ReturnType<FetchLike>>
    try {
      response = await this.fetch(`${API_PREFIX}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      })
    } catch (error) {
      return { ok: false, status: 0, message: error instanceof Error ? error.message : 'network error' }
    }
    let body: unknown
    try {
      body = await response.json()
    } catch {
      body = undefined
    }
    if (!response.ok) {
      const message = (body as { message?: string } | undefined)?.message ?? `request failed (${response.status})`
      return { ok: false, status: response.status, message }
    }
    // 建卡只返回 { issue }，其余返回完整视图；前者补一次 refresh 拿全量。
    const view = readView(body)
    if (view !== undefined) this.last = view
    else await this.refresh()
    return { ok: true, view: this.last ?? EMPTY }
  }

  createIssue(input: {
    title: string
    workspace: string
    description?: string
    priority?: string
    maxAttempts?: number
    exec?: Record<string, unknown>
  }): Promise<MutationResult> {
    return this.write('/issues', 'POST', input)
  }

  /** 新建一支小队（ADR-0016）。 */
  createSquad(squad: Record<string, unknown>): Promise<MutationResult> {
    return this.write('/squads', 'POST', squad)
  }

  /** 整体覆盖一支已存在的小队。id 不跟着改名走。 */
  updateSquad(id: string, squad: Record<string, unknown>): Promise<MutationResult> {
    return this.write(`/squads/${encodeURIComponent(id)}`, 'PATCH', squad)
  }

  deleteSquad(id: string): Promise<MutationResult> {
    return this.write(`/squads/${encodeURIComponent(id)}`, 'DELETE')
  }

  /**
   * 把一份 DSH 配置文件交给系统编辑器（ADR-0020）。
   *
   * 不走 {@link write}：它不改 Board，也不返回看板视图，拿它去走写链会白白
   * 多一次全量刷新。`opened: false` 不是错误——宿主打不开时 `path` 带回文件
   * 位置，由界面告知 Operator。
   */
  async openDocument(target: DocumentTarget): Promise<{ opened: boolean; path?: string }> {
    try {
      const response = await this.fetch(`${API_PREFIX}/open-document`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target }),
      })
      if (!response.ok) return { opened: false }
      const body = await response.json() as { opened?: unknown; path?: unknown }
      return {
        opened: body.opened === true,
        ...(typeof body.path === 'string' ? { path: body.path } : {}),
      }
    } catch {
      return { opened: false }
    }
  }

  /** 一次落一批卡片（票 13）。整批成功或整批不落。 */
  createBatch(workspace: string, titles: readonly string[]): Promise<MutationResult> {
    return this.write('/issues/batch', 'POST', { workspace, items: titles })
  }

  updateIssue(id: string, patch: Record<string, unknown>): Promise<MutationResult> {
    return this.write(`/issues/${encodeURIComponent(id)}`, 'PATCH', patch)
  }

  deleteIssue(id: string): Promise<MutationResult> {
    return this.write(`/issues/${encodeURIComponent(id)}`, 'DELETE')
  }

  moveIssue(id: string, target: { lane: string; beforeId?: string; afterId?: string }): Promise<MutationResult> {
    return this.write(`/issues/${encodeURIComponent(id)}/move`, 'POST', target)
  }

  gate(id: string, verdict: 'accept' | 'reject'): Promise<MutationResult> {
    return this.write(`/issues/${encodeURIComponent(id)}/gate`, 'POST', { verdict })
  }

  /** 派活：为这个 Issue 起一个 Run（票 07）。 */
  dispatch(id: string): Promise<MutationResult> {
    return this.write(`/issues/${encodeURIComponent(id)}/dispatch`, 'POST')
  }

  /** 停掉这个 Issue 正在进行的 Run。 */
  cancel(id: string): Promise<MutationResult> {
    return this.write(`/issues/${encodeURIComponent(id)}/cancel`, 'POST')
  }
}
