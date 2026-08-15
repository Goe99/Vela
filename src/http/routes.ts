/**
 * Vela 的 HTTP 面——**spec 里定的主接缝**。这一层刻意是纯
 * `request → response`：不碰 node 的 req/res，因此接缝测试可以直接
 * 驱动它，而不需要起一个真的 web server。
 *
 * 领域错误到状态码的映射集中在这里一处，别处不再 catch 猜语义。
 */

import type { Board, ExecOverrides, Priority, TokenUsage } from '../domain/types.ts'
import { LANES, PRIORITIES } from '../domain/types.ts'
import type { BoardErrorCode, BoardResult, CreateIssueInput, GateVerdict } from '../domain/board.ts'
import {
  createIssue, deleteIssue, gate, moveIssue, updateIssue,
} from '../domain/board.ts'
import type { BoardStore } from '../domain/store.ts'
import type { Lane } from '../domain/types.ts'
import { validateOverrides } from '../domain/exec.ts'
import { API_PREFIX } from './contract.ts'

export { API_PREFIX } from './contract.ts'

/** 一次进来的调用，已与传输层解耦。 */
export interface ApiRequest {
  readonly method: string
  /** 不含查询串的路径。 */
  readonly path: string
  /** 已解析的 JSON 请求体；无体或非 JSON 时为 undefined。 */
  readonly body?: unknown
}

/** 一次要发出的回复。 */
export interface ApiResponse {
  readonly status: number
  readonly body: unknown
}

/**
 * 派活能力。HTTP 层只靠这个窄接口认识执行器，因此接缝测试能用一个
 * fake 驱动全部路由，不需要真的 harness。
 */
export interface DispatchPort {
  dispatch(issueId: string): Promise<BoardResult<{ readonly sessionId: string }>>
  cancel(issueId: string): Promise<BoardResult<{ readonly sessionId: string }>>
  /** 在途 Run 的实时用量，按 Issue 索引。**不落盘**（ADR-0011）。 */
  liveUsageByIssue(): Record<string, TokenUsage>
}

/** 领域侧要用到的环境依赖，注入以便测试确定性重放。 */
export interface ApiDeps {
  readonly now: () => number
  readonly newId: () => string
  /** 宿主实际提供的权限 preset 名字，供校验与 UI 下拉。 */
  readonly sandboxPresets: () => readonly string[]
  /** 缺失表示这个部署不能派活（例如未挂载 apiProxy）。 */
  readonly dispatcher?: DispatchPort
}

const STATUS_BY_CODE: Readonly<Record<BoardErrorCode, number>> = {
  'not-found': 404,
  'invalid': 400,
  'illegal-transition': 409,
  'conflict': 409,
}

function json(status: number, body: unknown): ApiResponse {
  return { status, body }
}

function fromResult<T>(result: BoardResult<T>, onOk: (value: T) => ApiResponse): ApiResponse {
  if (!result.ok) return json(STATUS_BY_CODE[result.code], { ok: false, code: result.code, message: result.message })
  return onOk(result.value)
}

function asRecord(body: unknown): Record<string, unknown> | undefined {
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : undefined
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function isLane(value: unknown): value is Lane {
  return typeof value === 'string' && (LANES as readonly string[]).includes(value)
}

function isPriority(value: unknown): value is Priority {
  return typeof value === 'string' && (PRIORITIES as readonly string[]).includes(value)
}

/**
 * 读一份执行配置覆盖（票 11）。显式的 null 表示「清除覆盖、回落到全局
 * 默认」，与「没提这个字段」区分开。
 */
function readExec(value: unknown): ExecOverrides | undefined | 'invalid' {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'invalid'
  const raw = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of ['agentPreset', 'sandbox'] as const) {
    const field = raw[key]
    if (field === undefined || field === null) continue
    if (typeof field !== 'string') return 'invalid'
    out[key] = field
  }
  if (raw.timeoutMs !== undefined && raw.timeoutMs !== null) {
    if (typeof raw.timeoutMs !== 'number') return 'invalid'
    out.timeoutMs = raw.timeoutMs
  }
  return out as ExecOverrides
}

/**
 * 把 Board 投影成给浏览器的形状：快照本身，加上三项**不属于快照**的运行时
 * 事实。这三项刷新即变，故不能写进快照（它们分别是实时用量、宿主能力
 * 与部署提供的档位表）。
 */
function boardView(board: Board, deps: ApiDeps): unknown {
  return {
    ok: true,
    board,
    liveUsage: deps.dispatcher?.liveUsageByIssue() ?? {},
    sandboxPresets: deps.sandboxPresets(),
    canDispatch: deps.dispatcher !== undefined,
  }
}

/**
 * 处理一次 API 调用。
 *
 * 所有写操作都经 `store.mutate` 走同一条串行化写链，因此并发请求之间
 * 不会读改写交错。
 */
export async function handleApi(
  store: BoardStore,
  deps: ApiDeps,
  request: ApiRequest,
): Promise<ApiResponse> {
  const { method } = request
  const rest = request.path.startsWith(API_PREFIX) ? request.path.slice(API_PREFIX.length) : undefined
  if (rest === undefined) return json(404, { ok: false, code: 'not-found', message: 'unknown path' })
  // 路径完全由外部输入控制：非法百分号编码（如 /issues/%foo）会让
  // decodeURIComponent 抛错。捕获成 400，不让它冒泡成未处理异常。
  let segments: string[]
  try {
    segments = rest.split('/').filter(part => part.length > 0).map(part => decodeURIComponent(part))
  } catch {
    return json(400, { ok: false, code: 'invalid', message: 'path contains an invalid escape sequence' })
  }

  // GET /board
  if (method === 'GET' && segments.length === 1 && segments[0] === 'board') {
    return json(200, boardView(store.snapshot(), deps))
  }

  // POST /issues
  if (method === 'POST' && segments.length === 1 && segments[0] === 'issues') {
    const body = asRecord(request.body)
    if (body === undefined) return json(400, { ok: false, code: 'invalid', message: 'body must be an object' })
    const title = optionalString(body.title)
    const workspace = optionalString(body.workspace)
    if (title === undefined || workspace === undefined) {
      return json(400, { ok: false, code: 'invalid', message: 'title and workspace are required' })
    }
    if (body.priority !== undefined && !isPriority(body.priority)) {
      return json(400, { ok: false, code: 'invalid', message: 'unknown priority' })
    }
    const priority = isPriority(body.priority) ? body.priority : undefined
    const exec = readExec(body.exec)
    if (exec === 'invalid') {
      return json(400, { ok: false, code: 'invalid', message: 'exec must be an object of optional overrides' })
    }
    if (exec !== undefined) {
      const rejected = validateOverrides(exec, deps.sandboxPresets())
      if (rejected !== undefined) return json(400, { ok: false, code: 'invalid', message: rejected })
    }
    let created: BoardResult<{ board: Board; issue: unknown }> | undefined
    await store.mutate((board) => {
      const result = createIssue(board, {
        title,
        workspace,
        ...(optionalString(body.description) === undefined ? {} : { description: body.description as string }),
        ...(priority === undefined ? {} : { priority }),
        ...(typeof body.maxAttempts === 'number' ? { maxAttempts: body.maxAttempts } : {}),
        ...(exec === undefined ? {} : { exec }),
      }, deps.now(), deps.newId())
      created = result
      return result.ok ? { board: result.value.board, value: undefined } : undefined
    })
    return fromResult(created!, value => json(201, { ok: true, issue: value.issue }))
  }

  // POST /issues/batch —— 从会话提取出一批待办（票 13）。全部写入走同一次
  // mutate，因此要么整批落盘、要么一张也不落，不会留下半批卡片。
  if (method === 'POST' && segments.length === 2 && segments[0] === 'issues' && segments[1] === 'batch') {
    const body = asRecord(request.body)
    const items = body?.items
    const workspace = optionalString(body?.workspace)
    if (!Array.isArray(items) || workspace === undefined) {
      return json(400, { ok: false, code: 'invalid', message: 'workspace and items are required' })
    }
    if (items.length === 0) {
      return json(400, { ok: false, code: 'invalid', message: 'items must not be empty' })
    }
    const titles: string[] = []
    for (const item of items) {
      const title = typeof item === 'string' ? item : optionalString(asRecord(item)?.title)
      if (title === undefined || title.trim().length === 0) {
        return json(400, { ok: false, code: 'invalid', message: 'every item needs a non-empty title' })
      }
      titles.push(title.trim())
    }
    let outcome: BoardResult<Board> | undefined
    await store.mutate((board) => {
      let working = board
      for (const title of titles) {
        const input: CreateIssueInput = { title, workspace }
        const result = createIssue(working, input, deps.now(), deps.newId())
        if (!result.ok) {
          outcome = result
          return undefined
        }
        working = result.value.board
      }
      outcome = { ok: true, value: working }
      return { board: working, value: undefined }
    })
    return fromResult(outcome!, () => json(201, boardView(store.snapshot(), deps)))
  }

  if (segments[0] !== 'issues' || segments.length < 2) {
    return json(404, { ok: false, code: 'not-found', message: 'unknown path' })
  }
  const issueId = segments[1]!

  // PATCH /issues/:id
  if (method === 'PATCH' && segments.length === 2) {
    const body = asRecord(request.body)
    if (body === undefined) return json(400, { ok: false, code: 'invalid', message: 'body must be an object' })
    if (body.priority !== undefined && !isPriority(body.priority)) {
      return json(400, { ok: false, code: 'invalid', message: 'unknown priority' })
    }
    const priority = isPriority(body.priority) ? body.priority : undefined
    const exec = readExec(body.exec)
    if (exec === 'invalid') {
      return json(400, { ok: false, code: 'invalid', message: 'exec must be an object of optional overrides' })
    }
    if (exec !== undefined) {
      const rejected = validateOverrides(exec, deps.sandboxPresets())
      if (rejected !== undefined) return json(400, { ok: false, code: 'invalid', message: rejected })
    }
    let outcome: BoardResult<Board> | undefined
    await store.mutate((board) => {
      const result = updateIssue(board, issueId, {
        ...(optionalString(body.title) === undefined ? {} : { title: body.title as string }),
        ...(optionalString(body.description) === undefined ? {} : { description: body.description as string }),
        ...(optionalString(body.workspace) === undefined ? {} : { workspace: body.workspace as string }),
        ...(priority === undefined ? {} : { priority }),
        ...(typeof body.maxAttempts === 'number' ? { maxAttempts: body.maxAttempts } : {}),
        ...(exec === undefined ? {} : { exec }),
      }, deps.now())
      outcome = result
      return result.ok ? { board: result.value, value: undefined } : undefined
    })
    return fromResult(outcome!, () => json(200, boardView(store.snapshot(), deps)))
  }

  // DELETE /issues/:id
  if (method === 'DELETE' && segments.length === 2) {
    let outcome: BoardResult<Board> | undefined
    await store.mutate((board) => {
      const result = deleteIssue(board, issueId)
      outcome = result
      return result.ok ? { board: result.value, value: undefined } : undefined
    })
    return fromResult(outcome!, () => json(200, boardView(store.snapshot(), deps)))
  }

  // POST /issues/:id/move
  if (method === 'POST' && segments.length === 3 && segments[2] === 'move') {
    const body = asRecord(request.body)
    if (body === undefined || !isLane(body.lane)) {
      return json(400, { ok: false, code: 'invalid', message: 'lane is required and must be a known lane' })
    }
    const lane = body.lane
    const beforeId = optionalString(body.beforeId)
    const afterId = optionalString(body.afterId)
    let outcome: BoardResult<Board> | undefined
    await store.mutate((board) => {
      const result = moveIssue(board, issueId, {
        lane,
        ...(beforeId === undefined ? {} : { beforeId }),
        ...(afterId === undefined ? {} : { afterId }),
      }, deps.now())
      outcome = result
      return result.ok ? { board: result.value, value: undefined } : undefined
    })
    return fromResult(outcome!, () => json(200, boardView(store.snapshot(), deps)))
  }

  // POST /issues/:id/gate
  if (method === 'POST' && segments.length === 3 && segments[2] === 'gate') {
    const body = asRecord(request.body)
    const verdict = body?.verdict
    if (verdict !== 'accept' && verdict !== 'reject') {
      return json(400, { ok: false, code: 'invalid', message: 'verdict must be accept or reject' })
    }
    let outcome: BoardResult<Board> | undefined
    await store.mutate((board) => {
      const result = gate(board, issueId, verdict as GateVerdict, deps.now())
      outcome = result
      return result.ok ? { board: result.value, value: undefined } : undefined
    })
    return fromResult(outcome!, () => json(200, boardView(store.snapshot(), deps)))
  }

  // POST /issues/:id/dispatch —— 派活（票 07）。Issue 进 Running 由执行器
  // 在记下 Run 时驱动，不经 Operator 拖拽。
  if (method === 'POST' && segments.length === 3 && segments[2] === 'dispatch') {
    if (deps.dispatcher === undefined) {
      return json(409, {
        ok: false,
        code: 'conflict',
        message: 'this profile cannot dispatch Runs (no apiProxy is mounted)',
      })
    }
    const result = await deps.dispatcher.dispatch(issueId)
    return fromResult(result, value => json(202, {
      ok: true,
      sessionId: value.sessionId,
      ...(boardView(store.snapshot(), deps) as Record<string, unknown>),
    }))
  }

  // POST /issues/:id/cancel —— 停掉一次进行中的执行。
  if (method === 'POST' && segments.length === 3 && segments[2] === 'cancel') {
    if (deps.dispatcher === undefined) {
      return json(409, {
        ok: false,
        code: 'conflict',
        message: 'this profile cannot dispatch Runs (no apiProxy is mounted)',
      })
    }
    const result = await deps.dispatcher.cancel(issueId)
    return fromResult(result, () => json(202, boardView(store.snapshot(), deps)))
  }

  return json(404, { ok: false, code: 'not-found', message: 'unknown path' })
}
