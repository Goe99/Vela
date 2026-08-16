/**
 * Board 快照的持久化（ADR-0006）。单个人可读 JSON 文件，整份原子替换。
 *
 * 发布协议照官方 storage-json：同目录临时文件以 `wx`（排他创建）打开、
 * 写入后 fsync、`rename` 覆盖目标，POSIX 上再 fsync 父目录。rename 在
 * POSIX 与 Windows 上都是原子替换，因此**崩在任何一步都不会留下半写的
 * 快照**——要么是旧的完整文件，要么是新的完整文件。
 *
 * 这里刻意用 replace 语义而非 link()+unlink() 的 no-clobber：Board 在
 * 一个进程内只有一个写者（写链串行化），last-write-wins 是正确的。
 *
 * 路径**必须**由调用方显式给出。一个 `process.cwd()` 回落会把用户的
 * Board 散落在进程恰好启动的地方。
 */

import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { emptyBoard } from './types.ts'
import type { Board, Issue, Lane, Priority, Run } from './types.ts'
import { BOARD_VERSION, LANES, PRIORITIES } from './types.ts'

/** 快照文件的读写失败分类。 */
export type StoreErrorKind = 'malformed' | 'io'

/** 快照读写失败。 */
export class StoreError extends Error {
  constructor(readonly kind: StoreErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'StoreError'
  }
}

/** 序列化为人可读、可手改、可 git diff 的 JSON。 */
export function serialize(board: Board): string {
  return `${JSON.stringify(board, undefined, 2)}\n`
}

function isLane(value: unknown): value is Lane {
  return typeof value === 'string' && (LANES as readonly string[]).includes(value)
}

function isPriority(value: unknown): value is Priority {
  return typeof value === 'string' && (PRIORITIES as readonly string[]).includes(value)
}

function parseRun(raw: unknown, where: string): Run {
  if (typeof raw !== 'object' || raw === null) throw new StoreError('malformed', `${where} must be an object`)
  const record = raw as Record<string, unknown>
  if (typeof record.id !== 'string') throw new StoreError('malformed', `${where}.id must be a string`)
  if (typeof record.sessionId !== 'string') throw new StoreError('malformed', `${where}.sessionId must be a string`)
  if (record.status !== 'running' && record.status !== 'settled') {
    throw new StoreError('malformed', `${where}.status must be running or settled`)
  }
  return raw as Run
}

/**
 * 给缺编号的 Issue 补号。顺序按 (createdAt, id) 而非文件里的位置：位置会
 * 因为拖拽变，而这两个不会，所以同一份旧快照无论读多少次都得到同一套
 * 编号——这让一次写回失败只是“没落盘”，而不是“下次编号就变了”。
 *
 * 取最小可用正整数，因此已有编号不被碰。
 */
function assignMissingNumbers(
  issues: readonly Issue[],
  numbered: ReadonlyMap<string, number>,
): Map<string, number> {
  const assigned = new Map(numbered)
  const used = new Set(numbered.values())
  const pending = issues
    .filter(issue => !assigned.has(issue.id))
    .sort((left, right) => (left.createdAt - right.createdAt) || left.id.localeCompare(right.id))
  let candidate = 1
  for (const issue of pending) {
    while (used.has(candidate)) candidate += 1
    assigned.set(issue.id, candidate)
    used.add(candidate)
  }
  return assigned
}

/**
 * 解析一份快照。手工编辑出的错误必须报 malformed 而不是静默产出一个
 * 半损坏的 Board——Board 是 Operator 的系统记录，静默丢数据比报错更糟。
 *
 * 版本 1（无 Issue 编号）在此升级为当前版本。升级是**确定性**的，且不在
 * 这里落盘；落盘由 {@link BoardStore.open} 决定，因为那里才知道磁盘上原本是什么。
 */
export function parse(text: string): Board {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new StoreError('malformed', 'board snapshot is not valid JSON', { cause: error })
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new StoreError('malformed', 'board snapshot must be an object')
  }
  const record = raw as Record<string, unknown>
  if (record.version !== 1 && record.version !== BOARD_VERSION) {
    throw new StoreError('malformed', `unsupported board version ${String(record.version)}`)
  }
  if (!Array.isArray(record.issues)) {
    throw new StoreError('malformed', 'board.issues must be an array')
  }
  const seen = new Set<string>()
  const numbered = new Map<string, number>()
  const usedNumbers = new Set<number>()
  const issues = record.issues.map((rawIssue: unknown, index: number): Issue => {
    const where = `board.issues[${index}]`
    if (typeof rawIssue !== 'object' || rawIssue === null) {
      throw new StoreError('malformed', `${where} must be an object`)
    }
    const issue = rawIssue as Record<string, unknown>
    if (typeof issue.id !== 'string' || issue.id.length === 0) {
      throw new StoreError('malformed', `${where}.id must be a non-empty string`)
    }
    if (seen.has(issue.id)) throw new StoreError('malformed', `duplicate issue id ${issue.id}`)
    seen.add(issue.id)
    if (typeof issue.title !== 'string') throw new StoreError('malformed', `${where}.title must be a string`)
    if (typeof issue.workspace !== 'string') throw new StoreError('malformed', `${where}.workspace must be a string`)
    if (!isLane(issue.lane)) throw new StoreError('malformed', `${where}.lane is not a known lane`)
    if (!isPriority(issue.priority)) throw new StoreError('malformed', `${where}.priority is not a known priority`)
    if (typeof issue.position !== 'number' || !Number.isFinite(issue.position)) {
      throw new StoreError('malformed', `${where}.position must be a finite number`)
    }
    if (issue.number !== undefined) {
      if (!Number.isInteger(issue.number) || (issue.number as number) < 1) {
        throw new StoreError('malformed', `${where}.number must be a positive integer`)
      }
      const value = issue.number as number
      // 重复编号直接报错而不是重新分配：编号是 Operator 对外引用的句柄，
      // 静默改掉它比报错更危险。
      if (usedNumbers.has(value)) throw new StoreError('malformed', `duplicate issue number ${value}`)
      usedNumbers.add(value)
      numbered.set(issue.id, value)
    }
    const runs = Array.isArray(issue.runs) ? issue.runs : []
    return {
      ...(rawIssue as Issue),
      description: typeof issue.description === 'string' ? issue.description : '',
      maxAttempts: typeof issue.maxAttempts === 'number' ? issue.maxAttempts : 0,
      exec: typeof issue.exec === 'object' && issue.exec !== null ? (issue.exec as Issue['exec']) : {},
      runs: runs.map((run: unknown, runIndex: number) => parseRun(run, `${where}.runs[${runIndex}]`)),
    }
  })

  const assigned = assignMissingNumbers(issues, numbered)
  const highest = issues.reduce((max, issue) => Math.max(max, assigned.get(issue.id) ?? 0), 0)
  // 文件里声明的计数器优先，它才记得住已经退役的编号；但不能低于现有
  // 最大值，否则下一张卡会和已有的撞号。
  const declared = typeof record.nextNumber === 'number' && Number.isInteger(record.nextNumber)
    ? record.nextNumber
    : 0
  return {
    version: BOARD_VERSION,
    nextNumber: Math.max(declared, highest + 1),
    issues: issues.map(issue => ({ ...issue, number: assigned.get(issue.id)! })),
  }
}

/** fsync 一个 POSIX 目录，让刚 rename 出来的条目崩溃可幸存。 */
async function fsyncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** 用 `data` 原子地替换 `path`。 */
export async function writeAtomic(path: string, data: string): Promise<void> {
  const tmp = join(dirname(path), `.${randomUUID()}.tmp`)
  try {
    const handle = await open(tmp, 'wx', 0o600)
    try {
      await handle.writeFile(data, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(tmp, path)
    await fsyncDirectory(dirname(path))
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
}

/**
 * 一个打开的 Board 快照。内存状态是权威的；每次改动整份原子重写。
 *
 * 写入经一条**串行链**——`mutate` 的读改写不会交错。这是领域层要求的
 * 「同一份快照的读改写串行化」，放在这里是因为它是介质的性质，而不是
 * 每个调用点都要记得的纪律。
 */
export class BoardStore {
  private board: Board
  /** 写链尾。每次 mutate 挂在前一次之后，保证读改写不交错。 */
  private tail: Promise<unknown> = Promise.resolve()

  private constructor(readonly path: string, initial: Board) {
    this.board = initial
  }

  /**
   * 打开（读取或懒创建）一份快照。读到的内容经规范化后与磁盘不一致时
   * （最典型的是版本 1 的旧快照被补上了 Issue 编号），立即写回一次。
   *
   * 写回失败**不**阻止打开：升级是确定性的，下次读会得到完全相同的结果，
   * 所以没落盘的后果只是“每次启动都重做一次”，而不是数据飘。拿不到写权限
   * 时 Board 仍然完全可读，这比直接报错打不开强。
   * @param path - 绝对文件路径。相对路径直接拒绝，避免 cwd 依赖。
   */
  static async open(path: string): Promise<BoardStore> {
    if (!isAbsolute(path)) {
      throw new StoreError('io', `board path must be absolute, got ${path}`)
    }
    let text: string | undefined
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new StoreError('io', `cannot read board snapshot at ${path}`, { cause: error })
      }
      // 文件不存在 = 空 Board；物化推迟到第一次写入。
    }
    if (text === undefined) return new BoardStore(path, emptyBoard())
    const board = parse(text)
    const canonical = serialize(board)
    if (canonical !== text) {
      try {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 })
        await writeAtomic(path, canonical)
      } catch {
        // 故意吞下：见上方说明。
      }
    }
    return new BoardStore(path, board)
  }

  /** 当前快照。 */
  snapshot(): Board {
    return this.board
  }

  /**
   * 串行地读改写。`change` 拿到当前快照并返回下一个；返回 undefined
   * 表示放弃这次改动（不落盘）。发布失败则内存回滚——内存是权威的，
   * 一次被拒的写不能留在内存里，也不能搭下一次发布的车。
   */
  async mutate<T>(change: (board: Board) => { readonly board: Board; readonly value: T } | undefined): Promise<T | undefined> {
    const run = async (): Promise<T | undefined> => {
      const outcome = change(this.board)
      if (outcome === undefined) return undefined
      const previous = this.board
      this.board = outcome.board
      try {
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
        await writeAtomic(this.path, serialize(outcome.board))
      } catch (error) {
        this.board = previous
        throw new StoreError('io', `cannot publish board snapshot to ${this.path}`, { cause: error })
      }
      return outcome.value
    }
    const attempt = this.tail.then(run, run)
    // 只在跟踪分支吞掉拒绝：调用方仍然 await attempt 本身，所以异常被恰好观察一次。
    this.tail = attempt.catch(() => undefined)
    return attempt
  }
}
