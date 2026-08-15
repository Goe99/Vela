/**
 * Board 操作：给定一个 Board 快照与一个意图，产出新快照。全部是纯函数
 * ——不读时钟、不碰磁盘、不抛异常，失败经 `BoardResult` 显式返回，好让
 * HTTP 面把它映射成确定的状态码而不是靠 catch 猜。
 *
 * 时间与 id 由调用方注入（`Clock` / `IdGen`），因此同一序列的操作可以在
 * 测试里确定性重放。
 */

import type { Board, ExecOverrides, Issue, Lane, Priority, Run, RunOutcome, TokenUsage } from './types.ts'
import { canOperatorMove, systemTarget } from './lanes.ts'
import { byPosition, positionBetween, positionForEnd, renumber } from './ordering.ts'

/** 失败分类，直接决定 HTTP 状态码。 */
export type BoardErrorCode =
  /** 目标 Issue 或 Run 不存在 → 404 */
  | 'not-found'
  /** 状态机不允许这次迁移 → 409 */
  | 'illegal-transition'
  /** 入参不合法 → 400 */
  | 'invalid'
  /** 与当前状态冲突（例如已有活 Run） → 409 */
  | 'conflict'

/** 操作结果。 */
export type BoardResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: BoardErrorCode; readonly message: string }

function ok<T>(value: T): BoardResult<T> {
  return { ok: true, value }
}

function fail<T>(code: BoardErrorCode, message: string): BoardResult<T> {
  return { ok: false, code, message }
}

/** 新建一个 Issue 所需的输入。 */
export interface CreateIssueInput {
  readonly title: string
  readonly description?: string
  readonly workspace: string
  readonly priority?: Priority
  readonly maxAttempts?: number
  readonly exec?: ExecOverrides
}

/** 可修改的字段。未给出的字段保持原样。 */
export interface UpdateIssueInput {
  readonly title?: string
  readonly description?: string
  readonly workspace?: string
  readonly priority?: Priority
  readonly maxAttempts?: number
  readonly exec?: ExecOverrides
}

function find(board: Board, id: string): Issue | undefined {
  return board.issues.find(issue => issue.id === id)
}

function replace(board: Board, next: Issue): Board {
  return { ...board, issues: board.issues.map(issue => (issue.id === next.id ? next : issue)) }
}

/** 某个 Lane 内的 Issue，按展示次序。 */
export function laneIssues(board: Board, lane: Lane): readonly Issue[] {
  return board.issues.filter(issue => issue.lane === lane).sort(byPosition)
}

/** 一个 Issue 当前的活 Run（至多一个）。 */
export function activeRun(issue: Issue): Run | undefined {
  return issue.runs.find(run => run.status === 'running')
}

/** 一个 Issue 已经历的 Run 次数。 */
export function attemptCount(issue: Issue): number {
  return issue.runs.length
}

/**
 * 新建 Issue。落在 backlog 末尾（ADR-0012：新 Issue 只进 Backlog）。
 * maxAttempts 默认 0——不自动重试是刻意的默认值（ADR-0010）。
 */
export function createIssue(
  board: Board,
  input: CreateIssueInput,
  now: number,
  id: string,
): BoardResult<{ readonly board: Board; readonly issue: Issue }> {
  const title = input.title.trim()
  if (title.length === 0) return fail('invalid', 'title must not be empty')
  if (input.workspace.trim().length === 0) return fail('invalid', 'workspace must not be empty')
  const maxAttempts = input.maxAttempts ?? 0
  if (!Number.isInteger(maxAttempts) || maxAttempts < 0) {
    return fail('invalid', 'maxAttempts must be a non-negative integer')
  }
  const issue: Issue = {
    id,
    title,
    description: input.description ?? '',
    workspace: input.workspace,
    lane: 'backlog',
    priority: input.priority ?? 'none',
    position: positionForEnd(laneIssues(board, 'backlog').map(i => i.position)),
    createdAt: now,
    updatedAt: now,
    maxAttempts,
    exec: input.exec ?? {},
    runs: [],
  }
  return ok({ board: { ...board, issues: [...board.issues, issue] }, issue })
}

/** 修改 Issue 的内容。不改 lane 与 position——那走 moveIssue。 */
export function updateIssue(
  board: Board,
  id: string,
  input: UpdateIssueInput,
  now: number,
): BoardResult<Board> {
  const issue = find(board, id)
  if (issue === undefined) return fail('not-found', `issue ${id} not found`)
  if (input.title !== undefined && input.title.trim().length === 0) {
    return fail('invalid', 'title must not be empty')
  }
  if (input.maxAttempts !== undefined && (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 0)) {
    return fail('invalid', 'maxAttempts must be a non-negative integer')
  }
  const next: Issue = {
    ...issue,
    ...(input.title === undefined ? {} : { title: input.title.trim() }),
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.workspace === undefined ? {} : { workspace: input.workspace }),
    ...(input.priority === undefined ? {} : { priority: input.priority }),
    ...(input.maxAttempts === undefined ? {} : { maxAttempts: input.maxAttempts }),
    ...(input.exec === undefined ? {} : { exec: input.exec }),
    updatedAt: now,
  }
  return ok(replace(board, next))
}

/**
 * 删除 Issue。持有活 Run 时拒绝——先取消那次执行，否则会留下一个没有
 * 卡片指向的运行中会话。已结束的 Run 记录随 Issue 一起消失；它们指向的
 * DSH 会话**不受影响**，会话是 DSH 的资产不是 Vela 的。
 */
export function deleteIssue(board: Board, id: string): BoardResult<Board> {
  const issue = find(board, id)
  if (issue === undefined) return fail('not-found', `issue ${id} not found`)
  if (activeRun(issue) !== undefined) {
    return fail('conflict', `issue ${id} has a running Run; cancel it before deleting`)
  }
  return ok({ ...board, issues: board.issues.filter(candidate => candidate.id !== id) })
}

/** 拖拽的落点：夹在这两张卡片之间。两者都省略 = 落在目标 Lane 末尾。 */
export interface DropTarget {
  readonly lane: Lane
  readonly beforeId?: string
  readonly afterId?: string
}

/**
 * Operator 拖拽。非法迁移在此处被拒绝，调用方**不应**先接受再回滚。
 * 精度耗尽时自动重整目标 Lane 后重试一次——重整对 Operator 不可见，
 * 相对次序不变。
 */
export function moveIssue(
  board: Board,
  id: string,
  target: DropTarget,
  now: number,
): BoardResult<Board> {
  const issue = find(board, id)
  if (issue === undefined) return fail('not-found', `issue ${id} not found`)
  if (!canOperatorMove(issue.lane, target.lane)) {
    return fail('illegal-transition', `cannot move from ${issue.lane} to ${target.lane}`)
  }
  const siblings = laneIssues(board, target.lane).filter(candidate => candidate.id !== id)
  const before = target.beforeId === undefined
    ? undefined
    : siblings.find(candidate => candidate.id === target.beforeId)
  const after = target.afterId === undefined
    ? undefined
    : siblings.find(candidate => candidate.id === target.afterId)
  if (target.beforeId !== undefined && before === undefined) {
    return fail('not-found', `anchor ${target.beforeId} is not in lane ${target.lane}`)
  }
  if (target.afterId !== undefined && after === undefined) {
    return fail('not-found', `anchor ${target.afterId} is not in lane ${target.lane}`)
  }

  const settle = (working: Board, siblingList: readonly Issue[]): BoardResult<Board> => {
    const beforePos = before === undefined
      ? undefined
      : siblingList.find(candidate => candidate.id === before.id)?.position
    const afterPos = after === undefined
      ? undefined
      : siblingList.find(candidate => candidate.id === after.id)?.position
    const position = before === undefined && after === undefined
      ? positionForEnd(siblingList.map(i => i.position))
      : positionBetween(beforePos, afterPos)
    if (position === null) return fail('conflict', 'position precision exhausted')
    const moved: Issue = { ...issue, lane: target.lane, position, updatedAt: now }
    return ok(replace(working, moved))
  }

  const first = settle(board, siblings)
  if (first.ok) return first

  // 精度耗尽：重整目标 Lane 为 1..n 后再放一次。
  const order = renumber(siblings.map(candidate => candidate.id))
  const compacted: Board = {
    ...board,
    issues: board.issues.map((candidate) => {
      const position = order.get(candidate.id)
      return position === undefined ? candidate : { ...candidate, position, updatedAt: now }
    }),
  }
  return settle(compacted, laneIssues(compacted, target.lane).filter(candidate => candidate.id !== id))
}

/**
 * 派活：为 Issue 起一个 Run，Issue 自动进 running（系统驱动，Operator
 * 无法手动拖进来）。已有活 Run 时拒绝——一个 Issue 同时只能有一个。
 */
export function startRun(
  board: Board,
  id: string,
  run: { readonly id: string; readonly sessionId: string },
  now: number,
): BoardResult<Board> {
  const issue = find(board, id)
  if (issue === undefined) return fail('not-found', `issue ${id} not found`)
  if (activeRun(issue) !== undefined) {
    return fail('conflict', `issue ${id} already has a running Run`)
  }
  const lane = systemTarget('run-started', issue.lane)
  if (lane === undefined) {
    return fail('illegal-transition', `cannot start a Run while in ${issue.lane}`)
  }
  const started: Run = { id: run.id, sessionId: run.sessionId, startedAt: now, status: 'running' }
  const next: Issue = {
    ...issue,
    lane,
    position: positionForEnd(laneIssues(board, lane).map(i => i.position)),
    runs: [...issue.runs, started],
    updatedAt: now,
  }
  return ok(replace(board, next))
}

/**
 * Run 结束。成功进 review（**不是** done——ADR-0007 的核心不变量），
 * 其余进 failed。用量在此刻一次性写入 Run 且此后不可变（ADR-0011）；
 * 缺失表示未知，不要伪造成 0。
 */
export function settleRun(
  board: Board,
  id: string,
  settle: {
    readonly runId: string
    readonly outcome: RunOutcome
    readonly failure?: string
    readonly usage?: TokenUsage
  },
  now: number,
): BoardResult<Board> {
  const issue = find(board, id)
  if (issue === undefined) return fail('not-found', `issue ${id} not found`)
  const run = issue.runs.find(candidate => candidate.id === settle.runId)
  if (run === undefined) return fail('not-found', `run ${settle.runId} not found on issue ${id}`)
  if (run.status === 'settled') return fail('conflict', `run ${settle.runId} is already settled`)

  const succeeded = settle.outcome === 'completed'
  const lane = systemTarget(succeeded ? 'run-succeeded' : 'run-failed', issue.lane)
  if (lane === undefined) {
    return fail('illegal-transition', `cannot settle a Run while in ${issue.lane}`)
  }
  const settled: Run = {
    ...run,
    status: 'settled',
    endedAt: now,
    outcome: settle.outcome,
    ...(settle.failure === undefined ? {} : { failure: settle.failure }),
    ...(settle.usage === undefined ? {} : { usage: settle.usage }),
  }
  const next: Issue = {
    ...issue,
    lane,
    position: positionForEnd(laneIssues(board, lane).map(i => i.position)),
    runs: issue.runs.map(candidate => (candidate.id === run.id ? settled : candidate)),
    updatedAt: now,
  }
  return ok(replace(board, next))
}

/** Gate 的判定。 */
export type GateVerdict = 'accept' | 'reject'

/**
 * Gate：Operator 对一次产出的判定。这是通往终态的唯一入口——Run 结果
 * 自己到不了 done（ADR-0007）。
 */
export function gate(board: Board, id: string, verdict: GateVerdict, now: number): BoardResult<Board> {
  const issue = find(board, id)
  if (issue === undefined) return fail('not-found', `issue ${id} not found`)
  if (issue.lane !== 'review') {
    return fail('illegal-transition', `issue ${id} is not awaiting review`)
  }
  return moveIssue(board, id, { lane: verdict === 'accept' ? 'done' : 'todo' }, now)
}

/** 该 Issue 失败后是否还应自动重试（ADR-0010：默认 maxAttempts 0）。 */
export function shouldAutoRetry(issue: Issue): boolean {
  return issue.lane === 'failed' && issue.runs.length <= issue.maxAttempts
}
