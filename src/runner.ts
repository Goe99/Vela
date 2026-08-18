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
import type { Board, Issue, Run, RunOutcome, TokenUsage } from './domain/types.ts'
import { addUsage, readUsage } from './domain/usage.ts'
import { defaultFailure, parseTurnEnd } from './domain/outcome.ts'
import type { ExecDefaults } from './domain/exec.ts'
import { resolveExec, validateOverrides } from './domain/exec.ts'
import type {
  ApiProxyLike, AssistantMessageData, Dispose, PermissionPresetsLike, SessionEventLike,
  SessionStoreLike, ToolCallData,
} from './dsh.ts'
import type { Squad } from './domain/squad.ts'
import { leaderInstruction } from './domain/squad.ts'
import type { SquadResult } from './domain/squad-store.ts'
import type { FileTouch, RecallFacts, RecapDelivery, RunFacts } from './domain/okf-recap.ts'
import { extractDelivery } from './domain/okf-recap.ts'
import { selectRecall } from './domain/okf-recall.ts'
import type { Recall } from './domain/okf-recall.ts'
import type { MemoryPort } from './memory.ts'

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
  /**
   * 记忆库（ADR-0022）。**缺失表示没配 `memoryPath`**，此时整条落盘路径
   * 一行也不执行，派活文本也与从前一字不差。
   */
  readonly memory?: () => MemoryPort | undefined
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

/**
 * 读文件的工具叫什么。
 *
 * 取证自真跑日志（票 01）：工具名 `read`，文件路径在参数的 `file_path` 键上。
 * 写文件的工具名尚未取证，因此「写次数」按「除 read 外带 file_path 的调用」统计。
 */
const READ_TOOL = 'read'

/** 命令最多记几条。一次执行跑上百条命令时，全记下来只会把复盘淡成日志。 */
const MAX_COMMANDS = 20

/** 一条命令最多留多长。 */
const COMMAND_CLIP = 200

/** 对账出来的中断执行的失败说明。两处用到（快照与复盘），口径必须一致。 */
const INTERRUPTED_FAILURE = '上一次进程结束时这次执行仍在进行，结果未知'

/** 一次进行中的 Run 的在途状态。**不落盘**（ADR-0011）。 */
interface InFlight {
  readonly issueId: string
  readonly runId: string
  readonly sessionId: string
  /** 起跑时刻，算耗时用。 */
  readonly startedAt: number
  /**
   * 这次派给了哪支小队（小队 id）；没派给小队时 undefined。
   *
   * 只为一件事存在：取消时要把这支队**还在排队**的队员丢掉，否则取消之后
   * 还会有队员陆续冒出来起跑（ADR-0018）。
   */
  readonly squadId: string | undefined
  /** 实时累计用量，仅供展示；Run 结束时才写入快照。 */
  usage: TokenUsage | undefined
  /**
   * 这次碰过的文件：绝对路径 → 读写次数。与用量同款——攒在内存，不落盘。
   */
  readonly files: Map<string, { reads: number; writes: number }>
  /** 跑过的命令（已截断）。 */
  readonly commands: string[]
  /**
   * 最后一条 assistant 消息里的正文。
   *
   * 只留最新的一条而不是全部：收尾块在最后一条里（ADR-0021），而保留
   * 整段对话等于在内存里再存一份会话日志。
   */
  lastText: string | undefined
  /** 这次注入了多少召回；没有召回时缺失。 */
  recall: RecallFacts | undefined
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
      startedAt: this.deps.now(),
      squadId: squad?.id,
      usage: undefined,
      files: new Map(),
      commands: [],
      lastText: undefined,
      recall: undefined,
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

    // 召回：只挑这个工作区里经人验收过的复盘（ADR-0026 / 0027）。读不到或没候选
    // 时退化成「不注入」，而不是让派活失败——记忆是锦上添花，不是前置条件。
    const recalled = await this.prepareRecall(issue)
    if (recalled !== undefined) {
      entry.recall = {
        indexed: recalled.indexed.length,
        expanded: recalled.expanded.length,
        injectedChars: recalled.injectedChars,
        sourceChars: recalled.sourceChars,
      }
    }

    const prompted = await api.sessions.prompt({
      rpcId: this.deps.newId(),
      payload: {
        sessionId,
        mode: 'queue',
        content: [{
          type: 'text',
          // 没配记忆库时不加收尾要求：派活文本必须与从前一字不差（ADR-0027）。
          text: buildPrompt(issue, squad, undefined, {
            closing: this.deps.memory?.() !== undefined,
            ...(recalled === undefined || recalled.text.length === 0 ? {} : { recall: recalled.text }),
          }),
        }],
      },
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
    // 引用计数只在正文真被展开时自增，而且要等任务真的提交成功之后——
    // 提交失败的那一次，Agent 从未看到这些经验。计数写不上只记一句。
    if (recalled !== undefined && recalled.expanded.length > 0) {
      const memory = this.deps.memory?.()
      const at = this.deps.now()
      for (const used of recalled.expanded) {
        await memory?.countUse(used.path, at).catch((error: unknown) => {
          this.deps.logger?.warn(
            `vela: 引用计数没写上（${used.path}）：${error instanceof Error ? error.message : String(error)}`,
          )
        })
      }
    }
    return { ok: true, value: { issueId, runId, sessionId } }
  }

  /**
   * 读出这次要注入的召回。没配记忆库、读不到、或一个候选也没有时给 undefined。
   *
   * 读失败**不报错**：召回不成应当退化成「这次没带经验」，而不是让 Operator
   * 派不了活。记忆是锦上添花，不是派活的前置条件。
   */
  private async prepareRecall(issue: Issue): Promise<Recall | undefined> {
    const memory = this.deps.memory?.()
    if (memory === undefined) return undefined
    try {
      const candidates = await memory.recallCandidates()
      const recall = selectRecall(candidates, issue.workspace, this.deps.now())
      return recall.indexed.length === 0 ? undefined : recall
    } catch (error) {
      this.deps.logger?.warn(
        `vela: 召回读不成，这次不带经验：${error instanceof Error ? error.message : String(error)}`,
      )
      return undefined
    }
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
   * 消费一条会话事件。认三类：assistant/message 累计用量并留下正文，
   * tool/call 记下足迹，turn/end 结算。与本执行器无关的会话原样忽略——这是
   * 宿主的全局事件流。
   */
  observe(sessionId: string, event: SessionEventLike): void {
    const entry = this.inFlight.get(sessionId)
    if (entry === undefined) return
    if (event.type === 'assistant/message') {
      const usage = readUsage(event.data)
      if (usage !== undefined) {
        entry.usage = entry.usage === undefined ? usage : addUsage(entry.usage, usage)
      }
      // 正文与用量住在同一个事件上（票 01 取证）。这一次 cast 是诚实的：
      // `dsh.ts` 里那个形状是对着真跑日志声明的，读不到字段时退化成「没取到」。
      const text = assistantText(event.data as AssistantMessageData | undefined)
      if (text.length > 0) entry.lastText = text
      return
    }
    if (event.type === 'tool/call') {
      noteToolCall(entry, event.data as ToolCallData | undefined)
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
    // 复盘落盘接在结算之后：快照是真相，一篇复盘没写成不能拖垮结算。
    // 也必须在自动重试**之前**——否则第 N 次的复盘会晚于第 N+1 次开跑。
    await this.landRecap(entry, outcome, failure).catch((error: unknown) => {
      this.deps.logger?.warn(
        `vela: 复盘没落盘（issue ${entry.issueId}）：${error instanceof Error ? error.message : String(error)}`,
      )
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
   * 把这次执行落成一篇复盘。没配记忆库时直接返回，一行也不执行。
   *
   * 正文只在**成功收尾**时取 Agent 的交付（ADR-0026）：失败与中断的执行
   * 收尾回复常常只有半句话或根本没有，拿它当经验会污染召回。
   */
  private async landRecap(entry: InFlight, outcome: RunOutcome, failure: string | undefined): Promise<void> {
    const memory = this.deps.memory?.()
    if (memory === undefined) return
    const issue = this.deps.store.snapshot().issues.find(candidate => candidate.id === entry.issueId)
    if (issue === undefined) return
    const at = this.deps.now()
    const seq = issue.runs.findIndex(run => run.id === entry.runId)
    const facts: RunFacts = {
      issueNumber: issue.number,
      runSeq: seq < 0 ? issue.runs.length : seq + 1,
      sessionId: entry.sessionId,
      workspace: issue.workspace,
      title: issue.title,
      outcome,
      ...(failure === undefined ? {} : { failure }),
      startedAt: entry.startedAt,
      endedAt: at,
      ...(entry.usage === undefined ? {} : { usage: entry.usage }),
      files: touchedFiles(entry),
      commands: [...entry.commands],
      ...(entry.recall === undefined ? {} : { recall: entry.recall }),
    }
    const delivery: RecapDelivery | undefined = outcome === 'completed' && entry.lastText !== undefined
      ? extractDelivery(entry.lastText)
      : undefined
    await memory.landRecap(facts, delivery, at)
  }

  /**
   * 启动时对账。上次进程被杀时停在 running 的 Run 不会自己结束——没有这一步
   * 那些卡片会永远停在 Running。它们的用量已随进程丢失，因此**不写用量**：
   * 缺失表示未知，不伪造成 0（ADR-0011）。
   *
   * 同样会落一篇**只有客观部分**的复盘（ADR-0026）：这次执行的足迹与正文都随
   * 进程没了，但「这张卡曾经跑过一次、结果未知」本身就是值得留下的事实。
   */
  async reconcile(): Promise<void> {
    const stale = this.deps.store.snapshot().issues
      .flatMap(issue => issue.runs
        .filter(run => run.status === 'running' && !this.inFlight.has(run.sessionId))
        .map(run => ({ issue, run, runSeq: issue.runs.indexOf(run) + 1 })))
    if (stale.length === 0) return
    this.deps.logger?.info(`vela: settling ${stale.length} Run(s) left running by a previous process`)
    for (const { issue, run, runSeq } of stale) {
      await this.deps.store.mutate((board) => {
        const result = settleRun(board, issue.id, {
          runId: run.id,
          outcome: 'interrupted',
          failure: INTERRUPTED_FAILURE,
        }, this.deps.now())
        return result.ok ? { board: result.value, value: undefined } : undefined
      })
      await this.landInterrupted(issue, run, runSeq).catch((error: unknown) => {
        this.deps.logger?.warn(
          `vela: 对账出的复盘没落盘（issue ${issue.id}）：${error instanceof Error ? error.message : String(error)}`,
        )
      })
    }
  }

  /**
   * 给一条对账出来的中断执行落一篇客观复盘。
   *
   * 足迹是空的而不是伪造的：那些计数只活在上一个进程的内存里，现在无处可取。
   */
  private async landInterrupted(issue: Issue, run: Run, runSeq: number): Promise<void> {
    const memory = this.deps.memory?.()
    if (memory === undefined) return
    await memory.landRecap({
      issueNumber: issue.number,
      runSeq,
      sessionId: run.sessionId,
      workspace: issue.workspace,
      title: issue.title,
      outcome: 'interrupted',
      failure: INTERRUPTED_FAILURE,
      startedAt: run.startedAt,
      endedAt: this.deps.now(),
      files: [],
      commands: [],
    }, undefined, this.deps.now())
  }

  /** 清理全部计时器。在途 Run 留在快照里，下次启动由 reconcile 结算。 */
  dispose(): void {
    this.disposed = true
    for (const sessionId of [...this.inFlight.keys()]) this.forget(sessionId)
  }
}

/**
 * 一条 assistant 消息里的全部文本块拼起来。
 *
 * 只取 `type === 'text'` 的块：同一条消息里还会有 reasoning 与 tool-call 块
 * （票 01 取证），前者是思考过程、后者是调用参数，那两样都不是交付。
 */
function assistantText(data: AssistantMessageData | undefined): string {
  const blocks = data?.message?.content
  if (blocks === undefined) return ''
  const texts: string[] = []
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text)
  }
  return texts.join('\n').trim()
}

/**
 * 记下一次工具调用的足迹。
 *
 * 参数读不懂时安静跳过：足迹是尽力而为的记录，少一条比把整次执行弄崩好。
 * “写”的判定是「除 read 外带 file_path 的调用」——写文件的工具名尚未取证（票 01）。
 */
function noteToolCall(entry: InFlight, data: ToolCallData | undefined): void {
  const name = data?.name
  if (typeof name !== 'string' || name.length === 0) return
  let args: Record<string, unknown> = {}
  if (typeof data?.arguments === 'string') {
    try {
      const parsed: unknown = JSON.parse(data.arguments)
      if (typeof parsed === 'object' && parsed !== null) args = parsed as Record<string, unknown>
    } catch {
      // 参数不是 JSON 就当没有参数。
    }
  }
  const path = args.file_path
  if (typeof path === 'string' && path.length > 0) {
    const touch = entry.files.get(path) ?? { reads: 0, writes: 0 }
    if (name === READ_TOOL) touch.reads += 1
    else touch.writes += 1
    entry.files.set(path, touch)
  }
  const command = args.command
  if (typeof command === 'string' && command.length > 0 && entry.commands.length < MAX_COMMANDS) {
    entry.commands.push(command.length > COMMAND_CLIP ? `${command.slice(0, COMMAND_CLIP)}…` : command)
  }
}

/** 在途状态里的文件足迹整理成确定顺序的清单。 */
function touchedFiles(entry: InFlight): readonly FileTouch[] {
  return [...entry.files]
    .map(([path, touch]) => ({ path, reads: touch.reads, writes: touch.writes }))
    .sort((left, right) => left.path.localeCompare(right.path))
}

/**
 * 附在派活文本末尾的收尾要求（ADR-0021 / ADR-0027）。
 *
 * 最后一句是必要的：把「你无权宣布自己可信」直接告诉 Agent，比等它写了
 * 再在解析时默默丢掉要诚实——两头都做，但只靠后者会让它反复写一个没用的字段。
 */
const CLOSING_REQUIREMENT = [
  '## 收尾要求',
  '',
  '做完之后，在你最后一条消息里附一个 `vela-recap` 围栏块，按下面三个小标题分段：',
  '',
  '```vela-recap',
  '## 结论',
  '（这次的结果，一两句话）',
  '## 做了什么',
  '（关键改动）',
  '## 坑与注意',
  '（下一个人该知道的事；没有就写「无」）',
  '```',
  '',
  '这段会被存进记忆库，经人验收后成为以后派活时的参考。不要在块里写状态或验收字段——那由验收决定，不由你声明。',
].join('\n')

/** 拼派活文本时的可选项。 */
export interface PromptOptions {
  /**
   * 要不要附上收尾要求。没配记忆库时为假：那时没有任何地方存这篇复盘，
   * 而派活文本必须与从前一字不差。
   */
  readonly closing?: boolean
  /** 要前置的召回段落（已带标题）；缺省表示这次没有可召回的经验。 */
  readonly recall?: string
}

/**
 * 交给 Agent 的任务文本。标题是要做的事，描述是补充，两者都原样给出。
 *
 * 普通卡不包装任何指令——Agent 的行为应由 preset 决定，不由 Vela 悄悄注入。
 * **两处刻意的例外**：派给小队的卡前置队长职责与名册（接缝形状逼的，详见
 * `leaderInstruction`）；开了记忆库时附一段收尾要求（ADR-0027）。两者都带明确标题
 * 并用分隔线隔开，因此“哪一段是 Vela 加的”对人和 Agent 都看得出来。
 *
 * @param squad - 派给的小队；缺省表示这张卡没指定小队。
 * @param platform - 展开能力白名单用的平台；缺省用当前进程的。
 * @param options - 额外要附上的段落。
 */
export function buildPrompt(
  issue: Issue,
  squad?: Squad,
  platform?: string,
  options?: PromptOptions,
): string {
  const description = issue.description.trim()
  const task = description.length === 0 ? issue.title : `${issue.title}\n\n${description}`
  const sections: string[] = []
  if (squad !== undefined) {
    // 队长的职责与队员名册只能走开场消息，不能走系统设定：基准 preset 已经占了
    // `deployment:persona` 那个段名，再注册一份会直接抛错（见 leaderInstruction）。
    const briefing = leaderInstruction(squad, platform ?? PLATFORM).trim()
    if (briefing.length > 0) sections.push(briefing)
  }
  // 顺序：职责 → 以前的经验 → 收尾要求 → 任务。经验放任务前面，因为它是背景；
  // 收尾要求紧贴任务，因为它是对这次交付的要求。
  if (options?.recall !== undefined && options.recall.length > 0) sections.push(options.recall)
  if (options?.closing === true) sections.push(CLOSING_REQUIREMENT)
  // 一段都没有要加时原样交出任务：例外只在真的有东西要加时才成立。
  if (sections.length === 0) return task
  // 分隔必要：名册里带着 Markdown 标题，不隔的话卡片描述看起来会像名册的一部分。
  return `${sections.join('\n\n---\n\n')}\n\n---\n\n## 本次的任务\n\n${task}`
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
