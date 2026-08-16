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
import type { Squad, SquadMember } from '../domain/squad.ts'
import type { DocumentTarget } from '../domain/nav.ts'
import { DOCUMENT_TARGETS } from '../domain/nav.ts'
import type { SquadErrorCode, SquadResult } from '../domain/squad-store.ts'
import {
  ABILITIES, DEFAULT_MAX_PARALLEL_MEMBERS, MEMBER_BACKENDS, leaderInstruction, squadIdFor,
} from '../domain/squad.ts'
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
  /**
   * 部署所在平台。浏览器里没有 `process`，而小队编辑器要展示「跑命令」
   * 展开后的真实工具名（`pwsh` 还是 `bash`），所以这个事实必须由宿主告知。
   */
  readonly platform: () => string
  /** 缺失表示这个部署不能派活（例如未挂载 apiProxy）。 */
  readonly dispatcher?: DispatchPort
  /** 小队的读写。缺失表示这个部署没有可写的 preset 根，小队入口不现身。 */
  readonly squads?: SquadPort
  /** 小队并行时间轴的读取。缺失表示这个部署不记时间轴（ADR-0019）。 */
  readonly timeline?: TimelinePort
  /** 把配置文件交给系统打开。缺失时对应的导航项退化为只显示路径。 */
  readonly documents?: DocumentPort
}

/**
 * 小队并行时间轴的读取（ADR-0019）。
 *
 * 按**会话 id** 而不是 Run id 索引：记录发生在队员起跑的路径上，那里手里有的
 * 是父 agent，而父 agent 与会话是同一个身份。前端拿 Run 的 sessionId 去查。
 *
 * 与实时用量同类：**不落盘**的运行时事实。
 */
export interface TimelinePort {
  spansFor(sessionId: string): readonly unknown[]
  parents(): readonly string[]
}

/**
 * 小队的读写能力。HTTP 层只靠这个窄接口认识 {@link SquadStore}，
 * 因此接缝测试能用一个内存 fake 驱动全部路由。
 */
export interface SquadPort {
  list(): Promise<readonly Squad[]>
  read(id: string): Promise<SquadResult<Squad>>
  write(squad: Squad, options?: { readonly expectNew?: boolean }): Promise<SquadResult<Squad>>
  remove(id: string): Promise<SquadResult<undefined>>
}

/**
 * 把一份 DSH 配置文件交给系统编辑器打开。
 *
 * 这是导航里「Agent 配置 / 运行时 / 设置」三项背后的全部能力——DSH 不给
 * 第三方插件页面导航（ADR-0020）。
 */
export interface DocumentPort {
  open(target: DocumentTarget): Promise<{ readonly opened: boolean; readonly path?: string }>
}

const STATUS_BY_CODE: Readonly<Record<BoardErrorCode, number>> = {
  'not-found': 404,
  'invalid': 400,
  'illegal-transition': 409,
  'conflict': 409,
}

const STATUS_BY_SQUAD_CODE: Readonly<Record<SquadErrorCode, number>> = {
  'not-found': 404,
  'invalid': 400,
  'conflict': 409,
  'io': 500,
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
  for (const key of ['agentPreset', 'sandbox', 'squad'] as const) {
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
 * 把 Board 投影成给浏览器的形状：快照本身，加上一批**不属于快照**的运行时
 * 事实。它们刷新即变，故不能写进快照：实时用量、宿主能力、部署提供的档位
 * 表、以及小队时间轴。
 */
function boardView(board: Board, deps: ApiDeps, squads: readonly Squad[]): unknown {
  return {
    ok: true,
    board,
    liveUsage: deps.dispatcher?.liveUsageByIssue() ?? {},
    sandboxPresets: deps.sandboxPresets(),
    canDispatch: deps.dispatcher !== undefined,
    /** 可选的小队——派活时的下拉靠它。 */
    squads,
    /** 这个部署能不能管理小队（没有可写 preset 根时为 false）。 */
    canManageSquads: deps.squads !== undefined,
    /** 部署平台，小队编辑器靠它展开工具白名单。 */
    platform: deps.platform(),
    /**
     * 小队时间轴，按**会话 id** 索引（ADR-0019）。
     *
     * 只带上真的有泳道的那些会话，而不是每个 Run 都给一个空数组：前者让前端
     * 能用「有没有这个键」区分「派了小队但一个队员也没派出」与「这不是小队 Run」。
     */
    timelines: timelineView(deps),
  }
}

/** 把时间轴投成一个按会话 id 索引的对象。没接记录器时给空对象。 */
function timelineView(deps: ApiDeps): Record<string, readonly unknown[]> {
  const timeline = deps.timeline
  if (timeline === undefined) return {}
  const out: Record<string, readonly unknown[]> = {}
  for (const sessionId of timeline.parents()) {
    const spans = timeline.spansFor(sessionId)
    if (spans.length > 0) out[sessionId] = spans
  }
  return out
}

/** 把一份未经校验的请求体读成一支小队；形状不对返回一条说明。 */
function readSquad(body: unknown, fallbackId?: string): Squad | { readonly error: string } {
  const raw = asRecord(body)
  if (raw === undefined) return { error: 'body must be an object' }
  const title = optionalString(raw.title)
  if (title === undefined || title.trim().length === 0) return { error: '小队要有名字' }
  const rawMembers = raw.members
  if (rawMembers !== undefined && !Array.isArray(rawMembers)) return { error: 'members must be an array' }
  const members: SquadMember[] = []
  for (const candidate of rawMembers ?? []) {
    const member = asRecord(candidate)
    if (member === undefined) return { error: '每个队员必须是一个对象' }
    const name = optionalString(member.name)
    if (name === undefined) return { error: '队员要有名字' }
    const abilities = Array.isArray(member.abilities)
      ? member.abilities.filter((value): value is typeof ABILITIES[number] =>
        ABILITIES.includes(value as typeof ABILITIES[number]))
      : []
    const extraTools = Array.isArray(member.extraTools)
      ? member.extraTools.filter((value): value is string => typeof value === 'string')
      : []
    const backend = optionalString(member.backend) ?? 'spawn'
    if (!MEMBER_BACKENDS.includes(backend as typeof MEMBER_BACKENDS[number])) {
      return { error: `队员 "${name}" 的执行后端 "${backend}" 不支持` }
    }
    members.push({
      name,
      instruction: optionalString(member.instruction) ?? '',
      abilities,
      ...(extraTools.length === 0 ? {} : { extraTools }),
      backend: backend as typeof MEMBER_BACKENDS[number],
    })
  }
  const parallel = raw.maxParallelMembers
  return {
    // 新建时由显示名推 id；编辑时 id 来自路径，**不**跟着改名走——改名就搬
    // 目录会让已经引用它的卡片指向一个不存在的小队。
    id: fallbackId ?? squadIdFor(title),
    title: title.trim(),
    instruction: optionalString(raw.instruction) ?? '',
    members,
    ...(optionalString(raw.sandbox) === undefined ? {} : { sandbox: raw.sandbox as string }),
    maxParallelMembers: typeof parallel === 'number' ? parallel : DEFAULT_MAX_PARALLEL_MEMBERS,
  }
}

/** 一支小队给浏览器的形状：定义本身，加上队长实际收到的完整职责说明。 */
function squadView(squad: Squad, platform: string): unknown {
  return { ...squad, resolvedInstruction: leaderInstruction(squad, platform) }
}

function fromSquadResult<T>(result: SquadResult<T>, onOk: (value: T) => ApiResponse): ApiResponse {
  if (!result.ok) {
    return json(STATUS_BY_SQUAD_CODE[result.code], { ok: false, code: result.code, message: result.message })
  }
  return onOk(result.value)
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
  
  // 小队名单每次请求**最多读一次**。不在请求之间缓存：目录随时可能被
  // Operator 手改，拿着一份过期名单去派活比多一次 readdir 贵得多；但也不在
  // 同一次请求里重复扫，否则一个响应里两处小队信息可能对不上。
  let squadCache: readonly Squad[] | undefined
  const listSquads = async (): Promise<readonly Squad[]> => {
    squadCache ??= deps.squads === undefined ? [] : await deps.squads.list()
    return squadCache
  }
  const viewJson = async (status: number): Promise<ApiResponse> =>
    json(status, boardView(store.snapshot(), deps, await listSquads()))
  /**
   * 一次写操作的统一收尾：失败映成状态码，成功回一份**完整**的看板视图。
   *
   * 必须是完整的：浏览器会直接采信写操作的返回值来刷新界面，少带一项
   * （比如小队名单）就会让那个下拉框在每次编辑后突然变空。
   */
  const settleWithView = async <T>(result: BoardResult<T>, status: number): Promise<ApiResponse> => {
    if (!result.ok) {
      return json(STATUS_BY_CODE[result.code], { ok: false, code: result.code, message: result.message })
    }
    return viewJson(status)
  }
  
  // 路径完全由外部输入控制：非法百分号编码（如 /issues/%foo）会让
  // decodeURIComponent 报错。捕获成 400，不让它冒泡成未处理异常。
  let segments: string[]
  try {
    segments = rest.split('/').filter(part => part.length > 0).map(part => decodeURIComponent(part))
  } catch {
    return json(400, { ok: false, code: 'invalid', message: 'path contains an invalid escape sequence' })
  }
  
  // GET /board
  if (method === 'GET' && segments.length === 1 && segments[0] === 'board') {
    return viewJson(200)
  }
  
  // POST /open-document —— 把一份 DSH 配置文件交给系统编辑器（ADR-0020）。
  if (method === 'POST' && segments.length === 1 && segments[0] === 'open-document') {
    const target = optionalString(asRecord(request.body)?.target)
    if (target === undefined || !(DOCUMENT_TARGETS as readonly string[]).includes(target)) {
      return json(400, {
        ok: false,
        code: 'invalid',
        message: `target must be one of ${DOCUMENT_TARGETS.join(', ')}`,
      })
    }
    if (deps.documents === undefined) {
      return json(409, { ok: false, code: 'conflict', message: '这个部署打不开配置文件' })
    }
    const outcome = await deps.documents.open(target as DocumentTarget)
    // opened=false 不是错误：宿主打不开时把路径告知 Operator，比一句报错有用。
    return json(200, { ok: true, ...outcome })
  }

  // ---- 小队（ADR-0016）----
  
  // GET /squads
  if (method === 'GET' && segments.length === 1 && segments[0] === 'squads') {
    if (deps.squads === undefined) {
      return json(200, { ok: true, squads: [], canManageSquads: false })
    }
    const squads = await listSquads()
    return json(200, {
      ok: true,
      squads: squads.map(squad => squadView(squad, deps.platform())),
      canManageSquads: true,
    })
  }
  
  // POST /squads
  if (method === 'POST' && segments.length === 1 && segments[0] === 'squads') {
    if (deps.squads === undefined) {
      return json(409, { ok: false, code: 'conflict', message: '这个部署没有可写的 preset 根，建不了小队' })
    }
    const parsed = readSquad(request.body)
    if ('error' in parsed) return json(400, { ok: false, code: 'invalid', message: parsed.error })
    const result = await deps.squads.write(parsed, { expectNew: true })
    return fromSquadResult(result, value => json(201, { ok: true, squad: squadView(value, deps.platform()) }))
  }
  
  // PATCH /squads/:id
  if (method === 'PATCH' && segments.length === 2 && segments[0] === 'squads') {
    if (deps.squads === undefined) {
      return json(409, { ok: false, code: 'conflict', message: '这个部署没有可写的 preset 根' })
    }
    const id = segments[1]!
    const existing = await deps.squads.read(id)
    if (!existing.ok) return fromSquadResult(existing, () => json(500, { ok: false }))
    const parsed = readSquad(request.body, id)
    if ('error' in parsed) return json(400, { ok: false, code: 'invalid', message: parsed.error })
    const result = await deps.squads.write(parsed)
    return fromSquadResult(result, value => json(200, { ok: true, squad: squadView(value, deps.platform()) }))
  }
  
  // DELETE /squads/:id
  if (method === 'DELETE' && segments.length === 2 && segments[0] === 'squads') {
    if (deps.squads === undefined) {
      return json(409, { ok: false, code: 'conflict', message: '这个部署没有可写的 preset 根' })
    }
    const result = await deps.squads.remove(segments[1]!)
    return fromSquadResult(result, () => json(204, { ok: true }))
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
    return settleWithView(outcome!, 201)
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
    return settleWithView(outcome!, 200)
  }

  // DELETE /issues/:id
  if (method === 'DELETE' && segments.length === 2) {
    let outcome: BoardResult<Board> | undefined
    await store.mutate((board) => {
      const result = deleteIssue(board, issueId)
      outcome = result
      return result.ok ? { board: result.value, value: undefined } : undefined
    })
    return settleWithView(outcome!, 200)
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
    return settleWithView(outcome!, 200)
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
    return settleWithView(outcome!, 200)
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
    if (!result.ok) {
      return json(STATUS_BY_CODE[result.code], { ok: false, code: result.code, message: result.message })
    }
    return json(202, {
      ok: true,
      sessionId: result.value.sessionId,
      ...(boardView(store.snapshot(), deps, await listSquads()) as Record<string, unknown>),
    })
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
    return settleWithView(result, 202)
  }

  return json(404, { ok: false, code: 'not-found', message: 'unknown path' })
}
