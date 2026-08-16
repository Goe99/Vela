/**
 * Delegation Slot（号牌）：小队里同时在跑的队员数的**硬**上限（ADR-0018）。
 *
 * 「硬」的意思是队员**根本起不来**，而不是在队长的职责说明里写一句「一次别派
 * 太多」。后者是劝告，模型可以忽略；这一层是队员起跑路径上的一道闸门。
 *
 * 这一层**不认识 DSH**：它只管「按 key 分组、每组最多 N 个同时持有」。这让全部
 * 排队语义都能在内存里用假时钟测——真实的并发 bug 极难复现，能测的部分必须真的
 * 能测。接上 DSH 的那薄薄一层在 `squad-provider.ts`。
 *
 * ## 两条刻意的选择
 *
 * **排队而不是拒绝。** 领不到号牌的队员在队列里等，对队长表现为「这个工具有点
 * 慢」。队长收不到任何「你被限流了」的信号——因为一旦它知道，它就会开始绕：改
 * 用匿名子代理、或者干脆自己动手。官方文档明确允许这种延迟：providers 的一个
 * 「shared capacity controller may delay an operation」。
 *
 * **宁可少拦也不能漏还。** 漏还一张号牌会永久缩小那支队的并发能力，症状是「越用
 * 越慢」，而且没有任何报错指向原因。所以这里有两道保险：release 幂等，以及一个
 * 超时兜底对账——即使结束信号根本没来，号牌最终也会被回收。
 */

/** 一张号牌。释放是**幂等**的：同一张牌还两次只还一个坑位。 */
export interface SlotTicket {
  release(): void
}

/** 号牌池要用到的环境。注入以便测试用假时钟。 */
export interface SlotPoolDeps {
  /** 计时器，用于超时兜底回收。 */
  readonly setTimer: (fn: () => void, ms: number) => unknown
  readonly clearTimer: (handle: unknown) => void
  /**
   * 一张号牌最长可以被持有多久，超过就强制回收。
   *
   * 这不是给队员的执行超时——那是 DSH 的事。这是**对账**：如果结束信号因为任何
   * 原因没有送到（进程内的异常路径、provider 换了实现、我们自己写错了），号牌
   * 也不会永久卡住。设 0 或负数关掉兜底。
   */
  readonly maxHoldMs: number
  readonly logger?: { warn(message: unknown): void }
}

/** 一个在排队的请求。 */
interface Waiter {
  readonly resolve: (ticket: SlotTicket) => void
  readonly reject: (error: Error) => void
  /** 摘除这个等待者自己的取消监听。排队被放行或被丢弃时都要调。 */
  readonly detach: () => void
}

/** 一个 key 的号牌账本。 */
interface Ledger {
  /** 当前有多少张牌在外面。 */
  held: number
  /** 这个 key 的上限。每次 acquire 都会刷新它——改小队设置不用重启。 */
  limit: number
  readonly waiting: Waiter[]
}

/** 排队被取消时抛出的错误。调用方据此把这次起跑当作「已取消」而不是「失败」。 */
export class SlotAbortedError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'SlotAbortedError'
  }
}

/**
 * 按 key 分组的号牌池。
 *
 * key 就是小队 id：号牌是**每支队**的，不是全局的。两支队各自的三个队员应当能
 * 同时跑——看板级的总闸门是另一回事，由 Runner 的并发上限管（ADR-0018 的另一半）。
 */
export class SlotPool {
  private readonly ledgers = new Map<string, Ledger>()

  constructor(private readonly deps: SlotPoolDeps) {}

  /** 某个 key 当前在外面的号牌数。给测试与诊断用。 */
  heldFor(key: string): number {
    return this.ledgers.get(key)?.held ?? 0
  }

  /** 某个 key 当前排队的人数。给测试与诊断用。 */
  waitingFor(key: string): number {
    return this.ledgers.get(key)?.waiting.length ?? 0
  }

  /**
   * 领一张号牌。满额时返回的 promise 一直挂着，直到有人还牌。
   *
   * @param limit - 这个 key 的上限。**每次都传**：小队设置改了之后，下一次领牌
   *   就该按新数字来，而不是等进程重启。非正整数视为不限。
   * @param signal - 排队期间的取消通道。abort 时 promise 以 {@link SlotAbortedError}
   *   拒绝，且这个等待者被从队列里摘掉——否则它会在取消之后才冒出来起跑。
   */
  acquire(key: string, limit: number, signal?: AbortSignal): Promise<SlotTicket> {
    // 不限就直接给一张空牌。空牌的 release 是真的空操作，因此调用方不必分叉。
    if (!Number.isInteger(limit) || limit < 1) return Promise.resolve({ release: () => {} })

    const ledger = this.ledgerFor(key)
    ledger.limit = limit

    if (signal?.aborted === true) {
      return Promise.reject(new SlotAbortedError(abortReason(signal)))
    }

    if (ledger.held < ledger.limit) {
      ledger.held += 1
      return Promise.resolve(this.mint(key))
    }

    return new Promise<SlotTicket>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        detach: () => {
          if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort)
        },
      }
      const onAbort = signal === undefined ? undefined : () => {
        const at = ledger.waiting.indexOf(waiter)
        if (at >= 0) ledger.waiting.splice(at, 1)
        waiter.detach()
        reject(new SlotAbortedError(abortReason(signal)))
      }
      if (onAbort !== undefined) signal?.addEventListener('abort', onAbort, { once: true })
      ledger.waiting.push(waiter)
    })
  }

  /**
   * 丢掉某个 key 全部**还在排队**的请求。
   *
   * 用在整个 Run 被取消时：不这么做的话，取消之后还会有队员陆续冒出来起跑。
   * 已经在跑的队员不受影响——停它们是 DSH 的取消路径的事，不是号牌的事。
   */
  drainWaiting(key: string, reason: string): number {
    const ledger = this.ledgers.get(key)
    if (ledger === undefined) return 0
    const dropped = ledger.waiting.splice(0, ledger.waiting.length)
    for (const waiter of dropped) {
      waiter.detach()
      waiter.reject(new SlotAbortedError(reason))
    }
    return dropped.length
  }

  private ledgerFor(key: string): Ledger {
    const existing = this.ledgers.get(key)
    if (existing !== undefined) return existing
    const fresh: Ledger = { held: 0, limit: 1, waiting: [] }
    this.ledgers.set(key, fresh)
    return fresh
  }

  /**
   * 造一张号牌。牌自己记着「还没还过」，所以还两次只算一次。
   *
   * 幂等不是防御性编程的客套——`SubagentRun.result` 与我们自己的清理路径都可能
   * 走到还牌，两边都还一次就会凭空多出一个坑位，那支队的上限就此失效。
   */
  private mint(key: string): SlotTicket {
    let released = false
    const timer = this.deps.maxHoldMs > 0
      ? this.deps.setTimer(() => {
        if (released) return
        this.deps.logger?.warn(
          `vela: 一张 ${key} 的号牌持有超过 ${this.deps.maxHoldMs}ms，强制回收。`
          + '这通常意味着某个队员的结束信号没有送到。',
        )
        release()
      }, this.deps.maxHoldMs)
      : undefined

    const release = (): void => {
      if (released) return
      released = true
      if (timer !== undefined) this.deps.clearTimer(timer)
      this.handBack(key)
    }
    return { release }
  }

  /** 还一个坑位：先看有没有人在等，有就直接转手，避免坑位空转一轮。 */
  private handBack(key: string): void {
    const ledger = this.ledgers.get(key)
    if (ledger === undefined) return
    const next = ledger.waiting.shift()
    if (next === undefined) {
      ledger.held -= 1
      // 账本空了就删掉，否则一台长跑的机器会攒下一堆改过名的小队的空账本。
      if (ledger.held <= 0 && ledger.waiting.length === 0) this.ledgers.delete(key)
      return
    }
    // 坑位直接从上一张牌转给下一个人，`held` 因此不变。
    next.detach()
    next.resolve(this.mint(key))
  }
}

function abortReason(signal: AbortSignal): string {
  const reason: unknown = signal.reason
  if (typeof reason === 'string' && reason.length > 0) return reason
  if (reason instanceof Error) return reason.message
  return '这次派生被取消了'
}
