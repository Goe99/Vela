/**
 * Run 执行器（票 07/09/10/11）。把「派活」翻译成 DSH 的一次真实执行。
 *
 * 关键选择：**全程只经宿主的 apiProxy 服务与 Cordis 事件**，不 import 任何
 * @deepseek-ai 运行时模块。apiProxy 是官方自称「传输无关的网关面」——浏览器
 * 点「新会话」走的就是同一份实现，因此 Vela 派活得到的是官方开会话逻辑本身，
 * 而不是一份复制品。这同时绕开了两个坑：第三方插件解析不到捆绑在 dsh 安装内的
 * 那些包，以及复制官方消息结构会在上游改形状时静默失效。
 *
 * Run 是**顶层会话**而非 subagent 子会话（ADR-0013），因此 Operator 能像点开
 * 任何会话那样进去看 Agent 在干什么。
 */

import type { BoardStore } from './domain/store.ts'
import type { BoardResult } from './domain/board.ts'
import { activeRun, settleRun, shouldAutoRetry, startRun } from './domain/board.ts'
import type { Board, Issue, RunOutcome, TokenUsage } from './domain/types.ts'
import { addUsage, readUsage } from './domain/usage.ts'
import { defaultFailure, parseTurnEnd } from './domain/outcome.ts'
import type { ExecDefaults } from './domain/exec.ts'
import { resolveExec, validateOverrides } from './domain/exec.ts'
import type {
  ApiProxyLike, Dispose, PermissionPresetsLike, SessionEventLike, SessionStoreLike,
} from './dsh.ts'
import type { Squad } from './domain/squad.ts'
import { leaderInstruction } from './domain/squad.ts'
import type { SquadResult } from './domain/squad-store.ts'

/**
 * 展开能力白名单用的平台。队长的开场名册要括号列出每个队员可用的工具，
 * 而那张表按平台分叉（`pwsh` / `bash`）。这里读一次就好：进程跑到一半不会换
 * 操作系统。
 */
const PLATFORM = process.platform

/** 执行器靠这个窄接口读小队，好让测试用一个内存 fake 驱动。 */
export interface SquadReader {
  read(id: string): Promise<SquadResult<Squad>>
}

/**
 * 号牌池里执行器唯一用得到的那一个方法。
 *
 * 只要这一个而不是整个 `SlotPool`：执行器不应该能领牌。领牌是队员起跑路径上
 * 的事（provider 层），两层都能动同一个账本是号牌漏还的典型源头。
 */
export interface SlotDrain {
  drainWaiting(key: string, reason: string): number
}

/** 执行器要用到的环境。全部注入，好让测试用 fake 驱动完整链路。 */
export interface RunnerDeps {
  readonly store: BoardStore
  readonly now: () => number
  readonly newId: () => string
  readonly defaults: ExecDefaults
  /**
   * 同时在跑的 Run 上限（ADR-0018）。每次重新取，因此改配置不用重启。
   * 非正整数视为不限；0 是真的 0（全面暂停派活）。
   */
  readonly maxConcurrentRuns: () => number
  /** 每次都重新取——服务可能在 Vela 之后才挂载。 */
  readonly apiProxy: () => ApiProxyLike | undefined
  readonly permissionPresets: () => PermissionPresetsLike | undefined
  readonly sessions: () => SessionStoreLike | undefined
  /**
   * 小队的读取。缺失表示这个部署没有可写 preset 根，指定了小队的卡会被拒。
   */
  readonly squads: () => SquadReader | undefined
  /**
   * 号牌池（ADR-0018）。只用于一件事：取消一张卡时把那支队还在排队的队员
   * 丢掉。缺失表示号牌层没挂上（那时本来就没有队列）。
   */
  readonly slots?: () => SlotDrain
  /** 计时器，注入以便测试不真的等。 */
  readonly setTimer: (fn: () => void, ms: number) => unknown
  readonly clearTimer: (handle: unknown) => void
  readonly logger?: { warn(message: unknown): void; info(message: unknown): void }
}

/** 一次派活的结果。 */
export interface DispatchResult {
  readonly issueId: string
  readonly runId: string
  readonly sessionId: string
}

/**
 * 取消之后等待真正结束的宽限。`cancel` 返回不等于执行已结束，但也不能无限
 * 等——若宽限内没等到 turn/end，就按超时强制结算，免得卡片永远停在 Running。
 */
const CANCEL_GRACE_MS = 30_000

/** 一次进行中的 Run 的在途状态。**不落盘**（ADR-0011）。 */
interface InFlight {
  readonly issueId: string
  readonly runId: string
  readonly sessionId: string
  /**
   * 这次派给了哪支小队（小队 id）；没派给小队时 undefined。
   *
   * 只为一件事存在：取消时要把这支队**还在排队**的队员丢掉，否则取消之后
   * 还会有队员陆续冒出来起跑（ADR-0018）。
   */
  readonly squadId: string | undefined
  /** 实时累计用量，仅供展示；Run 结束时才写入快照。 */
  usage: TokenUsage | undefined
  /** 超时已触发：此后 turn/end 应记为 timeout 而非 aborted。 */
  timedOut: boolean
  timeout: unknown
  grace: unknown
}

/**
 * Run 执行器。拥有全部在途 Run 的生命周期，`dispose` 后不留计时器。
 */
export class Runner {
  private readonly deps: RunnerDeps
  /** sessionId → 在途 Run。会话事件按此路由。 */
  private readonly inFlight = new Map<string, InFlight>()
  /** issueId → 正在进行的派活，防止同一 Issue 并发派活建出孤儿会话。 */
  private readonly dispatching = new Map<string, Promise<BoardResult<DispatchResult>>>()
  /**
   * 全局派活链尾。每次派活整体挂在前一次之后。
   *
   * 为什么要全局串行而不只按 Issue 串行：并发上限的检查读的是快照里
   * 「现在几个在跑」。两张**不同**的卡同时派活时，两边都会读到同一个
   * 低于上限的数，然后都建会话——上限就漏了。派活是人手动触发的、
   * 每次只有几十毫秒，串行的代价远小于把计数器写对的难度。
   */
  private admissionTail: Promise<unknown> = Promise.resolve()
  private disposed = false

  constructor(deps: RunnerDeps) {
    this.deps = deps
  }

  /** 当前持有活 Run 的 Issue 数——快照是权威的，与 Operator 在 Running 列里看到的一致。 */
  runningCount(): number {
    return this.deps.store.snapshot().issues.filter(issue => activeRun(issue) !== undefined).length
  }

  /** 某个 Issue 当前在途 Run 的实时用量；无在途 Run 时 undefined。 */
  liveUsage(issueId: string): TokenUsage | undefined {
    for (const entry of this.inFlight.values()) {
      if (entry.issueId === issueId) return entry.usage
    }
    return undefined
  }

  /** 全部在途 Run 的实时用量，按 Issue 索引，供 Board 一次取齐。 */
  liveUsageByIssue(): Record<string, TokenUsage> {
    const out: Record<string, TokenUsage> = {}
    for (const entry of this.inFlight.values()) {
      if (entry.usage !== undefined) out[entry.issueId] = entry.usage
    }
    return out
  }

  /**
   * 派活：为一个 Issue 起一个 Run。同一 Issue 的并发调用被串行化，因此
   * 「已有活 Run」这个前置检查是权威的，不会先建好会话再发现建不了 Run。
   */
  async dispatch(issueId: string): Promise<BoardResult<DispatchResult>> {
    const pending = this.dispatching.get(issueId)
    if (pending !== undefined) {
      // 前一次派活尚未落定；等它结束再据当前状态判断，而不是并行建会话。
      // 这一步在全局链**之外**等，否则会自己等自己。
      await pending.catch(() => undefined)
    }
    const attempt = this.enqueue(() => this.dispatchOnce(issueId)).finally(() => {
      this.dispatching.delete(issueId)
    })
    this.dispatching.set(issueId, attempt)
    return attempt
  }

  /** 把一次派活排到全局链尾。上一次失败不能卡住下一次。 */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.admissionTail.then(task, task)
    this.admissionTail = next.catch(() => undefined)
    return next
  }

  private async dispatchOnce(issueId: string): Promise<BoardResult<DispatchResult>> {
    if (this.disposed) return { ok: false, code: 'conflict', message: 'vela is shutting down' }
    const api = this.deps.apiProxy()
    if (api === undefined) {
      return {
        ok: false,
        code: 'conflict',
        message: 'this profile mounts no apiProxy, so Vela cannot dispatch a Run',
      }
    }
    const issue = this.deps.store.snapshot().issues.find(candidate => candidate.id === issueId)
    if (issue === undefined) return { ok: false, code: 'not-found', message: `issue ${issueId} not found` }
    if (activeRun(issue) !== undefined) {
      return { ok: false, code: 'conflict', message: `issue ${issueId} already has a running Run` }
    }

    // 看板级并发上限（ADR-0018）。这一层是**拒绝**而不是排队：排队需要一个
    // 「排队中」状态，而六条 Lane 是钉死的（ADR-0009），于是一张卡会停在 Todo
    // 却其实在偷偷等——这种看不见的状态比一条明确的拒绝糟得多。
    const cap = this.deps.maxConcurrentRuns()
    if (Number.isInteger(cap) && cap >= 0) {
      const running = this.runningCount()
      if (running >= cap) {
        return {
          ok: false,
          code: 'conflict',
          message: cap === 0
            ? 'dispatching is paused: the concurrent Run limit is 0'
            : `already running ${running} of at most ${cap} Runs; wait for one to finish`,
        }
      }
    }

    const presets = this.deps.permissionPresets()
    const invalid = validateOverrides(issue.exec, presets?.names ?? [])
    if (invalid !== undefined) return { ok: false, code: 'invalid', message: invalid }
    const exec = resolveExec(issue.exec, this.deps.defaults)
    
    // 派给小队：小队就是一份 agent preset（ADR-0016），因此把它解成 preset 名字。
    //
    // 这里必须先确认小队**真的存在**：一支被删掉的小队会让 sessions.create
    // 报一个指向 preset 的错，Operator 看到的是一句不知所以的内部错误。
    let squad: Squad | undefined
    if (issue.exec.squad !== undefined) {
      const squads = this.deps.squads()
      if (squads === undefined) {
        return { ok: false, code: 'conflict', message: '这个部署没有小队能力，这张卡却指定了小队' }
      }
      const found = await squads.read(issue.exec.squad)
      if (!found.ok) {
        return {
          ok: false,
          code: found.code === 'not-found' ? 'not-found' : 'invalid',
          message: `小队 ${issue.exec.squad} 用不了：${found.message}`,
        }
      }
      squad = found.value
    }
    
    // 小队自带的档位优先于全局默认，但卡片上的显式覆盖优先于小队——越具体
    // 的意图越优先，这与 ADR-0010 的回落顺序一致。
    const sandbox = issue.exec.sandbox ?? squad?.sandbox ?? exec.sandbox
    const agentPreset = squad?.id ?? exec.agentPreset
    
    // 会话创建是第一个不可撒销的副作用，因此放在全部校验之后。
    const created = await api.sessions.create({
      rpcId: this.deps.newId(),
      payload: {
        cwd: issue.workspace,
        ...(agentPreset === undefined ? {} : { agentPreset }),
      },
    })
    if (!created.result.ok) {
      return {
        ok: false,
        code: created.result.error.code === 'session-conflict' ? 'conflict' : 'invalid',
        message: `cannot create a session: ${created.result.error.code}: ${created.result.error.message}`,
      }
    }
    const { sessionId } = created.result.value
    const runId = this.deps.newId()

    // 先把 Run 记入快照再提交任务：这样任何时刻「running 意味着快照里有一个
    // 活 Run」都成立，不会出现 Agent 已在跑而 Board 不知道的窗口。
    let recorded: BoardResult<Board> | undefined
    await this.deps.store.mutate((board) => {
      const result = startRun(board, issueId, { id: runId, sessionId }, this.deps.now())
      recorded = result
      return result.ok ? { board: result.value, value: undefined } : undefined
    })
    if (recorded === undefined || !recorded.ok) {
      this.deps.logger?.warn(
        `vela: session ${sessionId} was created but the Run could not be recorded; it is left idle and harmless`,
      )
      return recorded ?? { ok: false, code: 'conflict', message: 'the Run could not be recorded' }
    }

    const entry: InFlight = {
      issueId,
      runId,
      sessionId,
      squadId: squad?.id,
      usage: undefined,
      timedOut: false,
      timeout: undefined,
      grace: undefined,
    }
    this.inFlight.set(sessionId, entry)

    // 权限档位：会话已存在但尚未跑任何 turn，是施加档位的正确窗口。
    //
    // 对小队而言这一步**必须在提交任务之前**：DSH 在委派那一刻把父会话的沙箱
    // 覆盖快照给队员，晚了就只影响后续队员、已起跑的那些不变（ADR-0017）。
    if (sandbox !== undefined) {
      const applied = this.applySandbox(sessionId, sandbox)
      if (applied !== undefined) {
        await this.settle(sessionId, 'error', `cannot apply permission preset: ${applied}`)
        return { ok: false, code: 'invalid', message: applied }
      }
    }

    // 标题让 Run 在会话列表里可辨认。失败不影响执行，只记一句。
    const renamed = await api.sessions.rename({
      rpcId: this.deps.newId(),
      payload: { sessionId, title: issue.title },
    })
    if (!renamed.result.ok) {
      this.deps.logger?.warn(`vela: cannot title session ${sessionId}: ${renamed.result.error.message}`)
    }

    const prompted = await api.sessions.prompt({
      rpcId: this.deps.newId(),
      payload: { sessionId, mode: 'queue', content: [{ type: 'text', text: buildPrompt(issue, squad) }] },
    }).catch((error: unknown) => ({
      rpcId: '',
      result: { ok: false as const, error: { code: 'internal', message: String(error) } },
    }))
    if (!prompted.result.ok) {
      const message = `${prompted.result.error.code}: ${prompted.result.error.message}`
      await this.settle(sessionId, 'error', `cannot submit the task: ${message}`)
      return { ok: false, code: 'conflict', message }
    }

    if (exec.timeoutMs > 0) {
      entry.timeout = this.deps.setTimer(() => { void this.onTimeout(sessionId) }, exec.timeoutMs)
    }
    return { ok: true, value: { issueId, runId, sessionId } }
  }

  /** 施加权限档位。返回错误说明，或 undefined 表示成功。 */
  private applySandbox(sessionId: string, preset: string): string | undefined {
    const presets = this.deps.permissionPresets()
    if (presets === undefined) return 'this profile mounts no permissionPresets service'
    const session = this.deps.sessions()?.get(sessionId)
    if (session === undefined) return `session ${sessionId} is not attached, so its permission cannot be set`
    try {
      presets.set(session, preset)
      return undefined
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  /**
   * 消费一条会话事件。只认两类：assistant/message 累计用量，turn/end 结算。
   * 与本执行器无关的会话原样忽略——这是宿主的全局事件流。
   */
  observe(sessionId: string, event: SessionEventLike): void {
    const entry = this.inFlight.get(sessionId)
    if (entry === undefined) return
    if (event.type === 'assistant/message') {
      const usage = readUsage(event.data)
      if (usage !== undefined) {
        entry.usage = entry.usage === undefined ? usage : addUsage(entry.usage, usage)
      }
      return
    }
    if (event.type !== 'turn/end') return
    const end = parseTurnEnd(event.data)
    // 超时先于 turn/end 触发时，DSH 报的是 aborted；对 Operator 而言真实
    // 原因是超时，两者必须可区分（票 11）。
    const outcome: RunOutcome = entry.timedOut && end.outcome !== 'completed' ? 'timeout' : end.outcome
    const failure = outcome === 'completed'
      ? undefined
      : entry.timedOut ? defaultFailure('timeout') : end.failure ?? defaultFailure(outcome)
    this.settleDetached(sessionId, outcome, failure)
  }

  /** 取消一个 Issue 正在进行的 Run。 */
  async cancel(issueId: string): Promise<BoardResult<{ readonly sessionId: string }>> {
    const entry = [...this.inFlight.values()].find(candidate => candidate.issueId === issueId)
    if (entry === undefined) {
      return { ok: false, code: 'not-found', message: `issue ${issueId} has no Run in flight` }
    }
    await this.requestCancel(entry, 'aborted')
    return { ok: true, value: { sessionId: entry.sessionId } }
  }

  private async onTimeout(sessionId: string): Promise<void> {
    const entry = this.inFlight.get(sessionId)
    if (entry === undefined) return
    entry.timedOut = true
    await this.requestCancel(entry, 'timeout')
  }

  /**
   * 请求停止一次执行，然后**等待真正结束**。取消调用返回不代表执行已结束，
   * 因此这里只开一个有界宽限：等到 turn/end 就走正常结算，等不到就强制结算，
   * 免得卡片永远停在 Running。
   */
  private async requestCancel(entry: InFlight, reason: 'aborted' | 'timeout'): Promise<void> {
    // 先丢排队。顺序重要：先叫 DSH 取消的话，那一下之前刚好领到牌的队员
    // 会在取消之后才起跑，而它们不属于任何一个我们能看到的 Run（ADR-0018）。
    if (entry.squadId !== undefined) {
      const dropped = this.deps.slots?.().drainWaiting(entry.squadId, `这张卡已经被${reason === 'timeout' ? '超时中断' : '取消'}了`)
      if (dropped !== undefined && dropped > 0) {
        this.deps.logger?.info(`vela: 丢掉了 ${entry.squadId} 还在排队的 ${dropped} 个队员`)
      }
    }
    const api = this.deps.apiProxy()
    if (api === undefined) {
      await this.settle(entry.sessionId, reason, defaultFailure(reason))
      return
    }
    try {
      await api.sessions.cancel({ rpcId: this.deps.newId(), payload: { sessionId: entry.sessionId } })
    } catch (error) {
      this.deps.logger?.warn(`vela: cancel of session ${entry.sessionId} failed: ${String(error)}`)
    }
    if (entry.grace !== undefined) return
    entry.grace = this.deps.setTimer(() => {
      this.settleDetached(entry.sessionId, reason, `${defaultFailure(reason)}（未在宽限内收到结束事件）`)
    }, CANCEL_GRACE_MS)
  }

  /**
   * 把一次结算发出去但不等它（调用方在事件回调里，无处可 await）。
   *
   * 必须自己接住异常：结算要写盘，而写盘会真的失败（盘满、权限、目录
   * 被拿掉）。裸的 `void this.settle(...)` 会把那种失败变成未处理的 promise
   * 异常——在 Node 里默认会终止进程，也就是一张卡片没落盘把整个 dsh 拖下水。
   * 卡片停在 Running 很难看，但比提前退出强得多。
   */
  private settleDetached(sessionId: string, outcome: RunOutcome, failure: string | undefined): void {
    void this.settle(sessionId, outcome, failure).catch((error: unknown) => {
      this.deps.logger?.warn(
        `vela: cannot settle session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
      )
    })
  }

  /**
   * 结算一次 Run 并落盘。幂等：重复结算同一个 Run 是无操作，因为 turn/end
   * 与宽限计时器都可能到达。
   */
  private async settle(sessionId: string, outcome: RunOutcome, failure: string | undefined): Promise<void> {
    const entry = this.inFlight.get(sessionId)
    if (entry === undefined) return
    this.forget(sessionId)
    const usage = entry.usage
    await this.deps.store.mutate((board) => {
      const result = settleRun(board, entry.issueId, {
        runId: entry.runId,
        outcome,
        ...(failure === undefined ? {} : { failure }),
        ...(usage === undefined ? {} : { usage }),
      }, this.deps.now())
      return result.ok ? { board: result.value, value: undefined } : undefined
    })
    if (outcome === 'completed') return
    const issue = this.deps.store.snapshot().issues.find(candidate => candidate.id === entry.issueId)
    if (issue !== undefined && shouldAutoRetry(issue)) {
      this.deps.logger?.info(
        `vela: retrying issue ${issue.id} (attempt ${issue.runs.length + 1} of ${issue.maxAttempts + 1})`,
      )
      await this.dispatch(issue.id).catch(() => undefined)
    }
  }

  private forget(sessionId: string): void {
    const entry = this.inFlight.get(sessionId)
    if (entry === undefined) return
    if (entry.timeout !== undefined) this.deps.clearTimer(entry.timeout)
    if (entry.grace !== undefined) this.deps.clearTimer(entry.grace)
    this.inFlight.delete(sessionId)
  }

  /**
   * 启动时对账。上次进程被杀时停在 running 的 Run 不会自己结束——没有这一步
   * 那些卡片会永远停在 Running。它们的用量已随进程丢失，因此**不写用量**：
   * 缺失表示未知，不伪造成 0（ADR-0011）。
   */
  async reconcile(): Promise<void> {
    const stale = this.deps.store.snapshot().issues
      .flatMap(issue => issue.runs
        .filter(run => run.status === 'running' && !this.inFlight.has(run.sessionId))
        .map(run => ({ issueId: issue.id, runId: run.id })))
    if (stale.length === 0) return
    this.deps.logger?.info(`vela: settling ${stale.length} Run(s) left running by a previous process`)
    for (const { issueId, runId } of stale) {
      await this.deps.store.mutate((board) => {
        const result = settleRun(board, issueId, {
          runId,
          outcome: 'interrupted',
          failure: '上一次进程结束时这次执行仍在进行，结果未知',
        }, this.deps.now())
        return result.ok ? { board: result.value, value: undefined } : undefined
      })
    }
  }

  /** 清理全部计时器。在途 Run 留在快照里，下次启动由 reconcile 结算。 */
  dispose(): void {
    this.disposed = true
    for (const sessionId of [...this.inFlight.keys()]) this.forget(sessionId)
  }
}

/**
 * 交给 Agent 的任务文本。标题是要做的事，描述是补充，两者都原样给出。
 *
 * 普通卡不包装任何指令——Agent 的行为应由 preset 决定，不由 Vela 悄悄注入。
 *
 * **派给小队的卡是开了一个口子的例外。** 队长的职责与队员名册会前置到任务前面。
 * 这不是选择而是接缝形状逼的：那两样东西本应是系统设定，但基准 preset 已经占了
 * `deployment:persona` 那个段名，而那一行删不掉（详见 leaderInstruction）。
 *
 * @param squad - 派给的小队；缺省表示这张卡没指定小队。
 * @param platform - 展开能力白名单用的平台；缺省用当前进程的。
 */
export function buildPrompt(issue: Issue, squad?: Squad, platform?: string): string {
  const description = issue.description.trim()
  const task = description.length === 0 ? issue.title : `${issue.title}\n\n${description}`
  if (squad === undefined) return task
  // 队长的职责与队员名册只能走开场消息，不能走系统设定：基准 preset 已经占了
  // `deployment:persona` 那个段名，再注册一份会直接抛错（见 leaderInstruction）。
  const briefing = leaderInstruction(squad, platform ?? PLATFORM).trim()
  if (briefing.length === 0) return task
  // 职责在前、任务在后，中间用一个明确的分隔：名册里带着 Markdown 标题，不分
  // 隔的话卡片描述看起来会像名册的一部分。
  return `${briefing}\n\n---\n\n## 本次的任务\n\n${task}`
}

/** 能消费会话事件的东西。`Runner` 实现它。 */
export interface SessionObserver {
  observe(sessionId: string, event: SessionEventLike): void
}

/**
 * 把宿主的全局会话事件流接到观察者上。会话 id 从事件伴随的 session 对象的
 * header 上读——Vela 不解释 session 的其余结构。
 */
export function observeSessions(
  on: (listener: (session: unknown, event: SessionEventLike) => void) => Dispose,
  observer: SessionObserver,
): Dispose {
  return on((session, event) => {
    const id = sessionIdOf(session)
    if (id !== undefined) observer.observe(id, event)
  })
}

function sessionIdOf(session: unknown): string | undefined {
  if (typeof session !== 'object' || session === null) return undefined
  const header = (session as { header?: unknown }).header
  if (typeof header !== 'object' || header === null) return undefined
  const id = (header as { id?: unknown }).id
  return typeof id === 'string' ? id : undefined
}
