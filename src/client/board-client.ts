/**
 * 浏览器侧 Board API 客户端。轮询用 no-store + in-flight guard + 响应形状校验；
 * 失败保留最后一次成功快照，不把界面清空。
 *
 * fetch 经构造注入，因此可在 node 里用 fake 直接测这套取数/守卫逻辑，不需要
 * 真的网络。
 */

import { API_PREFIX } from '../http/contract.ts'
import type { Board, TokenUsage } from '../domain/types.ts'

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
}

/** 一次写操作的结果。 */
export type MutationResult =
  | { readonly ok: true; readonly view: BoardView }
  | { readonly ok: false; readonly status: number; readonly message: string }

function isBoard(value: unknown): value is Board {
  return typeof value === 'object' && value !== null
    && (value as { version?: unknown }).version === 1
    && Array.isArray((value as { issues?: unknown }).issues)
}

function readUsageMap(value: unknown): Readonly<Record<string, TokenUsage>> {
  if (typeof value !== 'object' || value === null) return {}
  return value as Record<string, TokenUsage>
}

function readStrings(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
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
  }
}

const EMPTY: BoardView = {
  board: { version: 1, issues: [] },
  liveUsage: {},
  sandboxPresets: [],
  canDispatch: false,
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
