/**
 * Vela 的委派后端：把 DSH 自带的 spawn / fork 包一层，在外面加一道号牌闸门
 * （ADR-0018）。
 *
 * 队员的组合行里填的是这一层的名字（`vela-spawn` / `vela-fork`），于是每个队员
 * 起跑都要先领到一张号牌。领不到就在队列里等——对队长表现为「这个工具有点慢」。
 *
 * ## 为什么是包装而不是自己实现一个 provider
 *
 * 派生一个子代理涉及作用域、审批、深度、结构化输出、preset 继承一大堆不变量，
 * 全都由 DSH 自己那份实现拥有。这一层**只加一件事**：起跑前领牌、结束后还牌。
 * 能力标记与 `inheritsParentContext` 都从被包的那个 provider 原样转发——它们是
 * 服务层拿去做校验和给模型生成措辞的依据，抄错一个字就会让行为悄悄偏离。
 *
 * ## 号牌拦得住什么，拦不住什么
 *
 * **拦得住**：所有走 `provider.start()` 的派生，也就是前台委派与一次性后台委派。
 *
 * **拦不住**：`prepareContinuable` 那条路。可继续子代理的整个生命周期归 DSH 的
 * continuation manager，provider 只贡献一份创建规格，之后既收不到结束信号也没有
 * handle。在那条路上领牌等于**必然漏还**，而漏还一张号牌会永久缩小那支队的并发
 * 能力，症状是「越用越慢」且没有任何报错指向原因。宁可少拦一条路，也不能漏还。
 *
 * 同理，**进程重启后可能短暂超额**：冷恢复的队员由 continuation manager 直接接
 * 回来，不经过这里。
 */

import type { SlotPool } from './domain/slots.ts'

/** 一次派生请求里 Vela 实际用到的部分。 */
export interface SubagentStartRequestLike {
  /**
   * 发起这次派生的 agent。`ctx` 是我们反查「这是哪支队」的入口，`id` 是它的
   * 会话身份——时间轴按它分组（ADR-0019）。
   */
  readonly parent: { readonly ctx: unknown; readonly id?: string }
  /** 起跑前与起跑后统一的取消通道。排队期间被 abort 就不该再起跑。 */
  readonly signal: AbortSignal
  /** 队长给这次委派写的任务描述。时间轴拿它当泳道标签。 */
  readonly label?: string
  /**
   * 这个子代理的专属人格，也就是我们写进组合文件的那段**队员职责说明**。
   *
   * 它是反查队员名唯一的拿手——DSH 给 provider 的请求里没有工具名。
   *
   * **读这一层而不是 `descriptor.persona`。** 一次真跑抓到了这个：one-shot 模式的
   * descriptor 快照里只有 version/mode/provider/label，**根本没有 persona**（只有
   * continuable 模式的快照才带）。而队员必须是 one-shot（ADR-0018），所以只能读
   * 请求根上的这个字段。
   */
  readonly persona?: string
  /** 子代理身份快照。保留作为回落：continuable 模式下 persona 在这里也有一份。 */
  readonly descriptor?: { readonly persona?: string }
}

/**
 * 一次派生的句柄。
 *
 * `result` 是**唯一**的结束信号——不是事件，也不是 `done`。它在子代理正常收尾时
 * resolve（哪怕子代理自己出错，`stopReason` 会是非 completed），只在基础设施
 * 故障时 reject。所以还牌与收尾记录都必须挂在它的两边。
 */
export interface SubagentRunLike {
  /** 子会话 id。时间轴的泳道点过去就是它。 */
  readonly id?: string
  readonly result: Promise<unknown>
}

/** 被包住的那个 DSH provider。 */
export interface SubagentProviderLike {
  readonly name: string
  readonly capabilities: Readonly<Record<string, boolean | undefined>>
  readonly inheritsParentContext: boolean
  start(request: SubagentStartRequestLike): Promise<SubagentRunLike>
  prepareContinuable?(request: unknown): Promise<unknown>
}

/** DSH 的子代理注册表中 Vela 用到的部分。 */
export interface SubagentsServiceLike {
  getProvider(name: string): SubagentProviderLike | undefined
  registerProvider(provider: SubagentProviderLike): () => void
}

/** 号牌层要问外界的几件事。 */
export interface SlottedProviderDeps {
  readonly slots: SlotPool
  /**
   * 从发起派生的 agent 反查它属于哪支队、那支队有几张号牌。
   *
   * 返回 undefined 表示「这不是一支 Vela 小队」——此时不设闸门直接转发。会走到
   * 这里是因为 Operator 可能手改过某份 preset、把我们的 provider 名填进了一个
   * 非小队的组合。那种情况下不该报错，也不该按某个猜出来的上限拦。
   *
   * `members` 是那支队的名册（名字 + 职责说明），用于从 `persona` 反查队员名。
   */
  quotaFor(parentCtx: unknown): Promise<SquadQuota | undefined>
  /**
   * 时间轴的记录口（ADR-0019）。缺省就不记——时间轴是可选能力，号牌不依赖它。
   */
  readonly timeline?: TimelineSink
  readonly now?: () => number
  readonly logger?: { warn(message: unknown): void }
}

/** 一支队的号牌配额与名册。 */
export interface SquadQuota {
  /** 号牌账本的 key，就是小队 id。 */
  readonly key: string
  /** 同时最多几个队员在跑。 */
  readonly limit: number
  /** 名册，用于把 `persona` 反查成队员名。 */
  readonly members?: readonly { readonly name: string; readonly instruction: string }[]
}

/** 时间轴记录器里这一层用得到的两个方法。 */
export interface TimelineSink {
  start(parentSessionId: string, span: {
    readonly runId: string
    readonly sessionId: string
    readonly label: string
    readonly member: string | undefined
    readonly at: number
  }): void
  end(parentSessionId: string, runId: string, at: number, stopReason: string | undefined, summary?: string): void
}

/** Vela 的后端名 = 原生名加这个前缀。 */
export const VELA_PROVIDER_PREFIX = 'vela-'

/** 被包装的原生后端名，按队员可选的后端一一对应。 */
export const WRAPPED_PROVIDERS: readonly string[] = ['spawn', 'fork']

/**
 * 造一个带号牌闸门的 provider，行为与被包的那个逐字一致，只是起跑前要排队。
 *
 * **为什么是工厂函数而不是类。** DSH 靠 `prepareContinuable` 这个属性的**有无**
 * 判断一个后端支不支持可继续子代理。类这条路上有两个坑，两个都踩过了：
 * 写成原型方法则 `delete` 删不掉；写成可选类字段则 `useDefineForClassFields`
 * 会把它定义成 `undefined`，`in` 照样为真。两种写法都会向 DSH 谎称支持，然后
 * 在真的被调时失败——症状是后台委派的队员起不来。对象字面量的条件展开让
 * 「有这个键」与「支持这件事」变成同一回事。
 */
export function slottedProvider(
  inner: SubagentProviderLike,
  deps: SlottedProviderDeps,
): SubagentProviderLike {
  const forward = inner.prepareContinuable
  return {
    name: `${VELA_PROVIDER_PREFIX}${inner.name}`,
    // 两个 getter 都是原样转发：能力标记是服务层校验「支不支持工具白名单」的
    // 依据，`inheritsParentContext` 是模型层生成「这个子代理看不看得到你的对话」
    // 那句措辞的依据。抄错一个字，行为会偏离而不是报错。
    get capabilities() {
      return inner.capabilities
    },
    get inheritsParentContext() {
      return inner.inheritsParentContext
    },

    /**
     * 结束信号的两边都要还牌。`result` 只在基础设施故障时 reject，但那恰恰是最
     * 需要还牌的情形——出故障还握着牌，那支队会一次比一次慢。
     *
     * 时间轴的两个时刻也在这里打（ADR-0019）。**这里而不是去监 `subagent/start`
     * 事件**：那个事件的载荷里没有父会话 id（它靠监听器的 `this` 传，而那是
     * dsh 内部的 carrier key），而这里父 agent 直接在手。同时它天然只盖住走我们
     * 后端的派生，也就是小队队员——正是「只在有小队的 Run 上出现」那条要求。
     */
    async start(request: SubagentStartRequestLike): Promise<SubagentRunLike> {
      const quota = await deps.quotaFor(request.parent.ctx).catch((error: unknown) => {
        // 反查失败不该挡住派活——那会让一个诊断信息问题升级成「队员起不来」。
        deps.logger?.warn(`vela: 查不到这次派生属于哪支队，本次不设号牌闸门：${describe(error)}`)
        return undefined
      })
      if (quota === undefined) return inner.start(request)

      const ticket = await deps.slots.acquire(quota.key, quota.limit, request.signal)
      let run: SubagentRunLike
      try {
        run = await inner.start(request)
      } catch (error) {
        // 起跑本身失败：牌必须当场还，否则这支队白丢一个坑位。
        ticket.release()
        throw error
      }
      const record = beginRecord(request, run, quota, deps)
      run.result.then(
        (result) => {
          ticket.release()
          // 队员最后一条消息的文本就是它的工作总结（persona 里的结束约定要求它写）。
          record?.(stopReasonOf(result), summaryOf(result))
        },
        (error: unknown) => {
          ticket.release()
          // 基础设施故障。没有 stopReason，给一个自己的词而不是置空——置空会让
          // 时间轴上这条泳道看起来像正常结束。
          record?.('infrastructure-error')
          deps.logger?.warn(`vela: 一个队员异常终止：${describe(error)}`)
        },
      )
      return run
    },

    // 转发但**不领号牌**，理由见文件开头：这条路上没有结束信号，领了必然漏还。
    ...(forward === undefined
      ? {}
      : { prepareContinuable: (request: unknown) => forward.call(inner, request) }),
  }
}

/**
 * 造出全部带号牌的 provider。
 *
 * 被包的原生 provider 不在时**跳过**而不是抛错：那意味着这个部署没装对应的
 * 委派后端，小队只是少一种队员后端可选，看板其余部分照常。
 *
 * `prepareContinuable` 的有无由 {@link slottedProvider} 在构造时自己对齐，这里
 * 不需要再做什么。
 */
export function slottedProvidersFor(
  subagents: SubagentsServiceLike,
  deps: SlottedProviderDeps,
): readonly SubagentProviderLike[] {
  const out: SubagentProviderLike[] = []
  for (const name of WRAPPED_PROVIDERS) {
    const inner = subagents.getProvider(name)
    if (inner === undefined) {
      deps.logger?.warn(`vela: 这个部署没有 ${name} 委派后端，小队里的 ${name} 队员将不可用`)
      continue
    }
    out.push(slottedProvider(inner, deps))
  }
  return out
}

/**
 * 把号牌层挂上去，返回一个卸载函数。
 *
 * 注册重名会抛（DSH 的注册表拒绝重复 provider 名）。这里逐个 try：一个挂不上不
 * 应该让另一个也挂不上，而且 HMR 时残留的旧注册正是最可能撞名的来源。
 */
export function installSlottedProviders(
  subagents: SubagentsServiceLike,
  deps: SlottedProviderDeps,
): () => void {
  const disposers: (() => void)[] = []
  for (const provider of slottedProvidersFor(subagents, deps)) {
    try {
      disposers.push(subagents.registerProvider(provider))
    } catch (error) {
      deps.logger?.warn(`vela: 挂不上委派后端 ${provider.name}：${describe(error)}`)
    }
  }
  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // 卸载失败没有可做的补救，也不该把插件卸载整个拖垮。
      }
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 开一条时间轴泳道，返回一个用来收尾的函数；记不了时返回 undefined。
 *
 * 记不了的情形全部是「缺了必需的身份」：没接记录器、拿不到父会话 id、拿不到
 * 子会话 id。这三种下**什么也不记**，而不是造一条带占位符的泳道：一条点不进去的
 * 泳道比没有那条泳道更坏。
 */
function beginRecord(
  request: SubagentStartRequestLike,
  run: SubagentRunLike,
  quota: SquadQuota,
  deps: SlottedProviderDeps,
): ((stopReason: string | undefined, summary?: string) => void) | undefined {
  const sink = deps.timeline
  const parentSessionId = request.parent.id
  const sessionId = run.id
  if (sink === undefined || parentSessionId === undefined || sessionId === undefined) return undefined
  const now = deps.now ?? (() => Date.now())
  // runId 用子会话 id：它在一个进程里唯一，而且正是泳道要跳过去的那个目标。
  sink.start(parentSessionId, {
    runId: sessionId,
    sessionId,
    label: request.label ?? '（未写任务描述）',
    member: memberNameOf(request, quota),
    at: now(),
  })
  return (stopReason, summary) => { sink.end(parentSessionId, sessionId, now(), stopReason, summary) }
}

/**
 * 从职责说明反查队员名。
 *
 * 为什么只能这么反查：DSH 给 provider 的请求里**没有队员的工具名**。而 persona
 * 正是我们自己写进组合文件的那段职责说明，因此能对回去。
 *
 * **优先读请求根上的 `persona`，而不是 `descriptor.persona`。** 一次真跑抓到了这个：
 * one-shot 模式的 descriptor 快照里只有 version/mode/provider/label，没有 persona，
 * 于是三条泳道的队员名全部反查失败。而队员必须是 one-shot（ADR-0018）。
 *
 * 两种查不到的情形，都返回 undefined 而不猜一个：队员没写职责（那时根本没有
 * persona），以及两个队员职责完全相同（那时它们本来就无法区分）。泳道的主标签
 * 是任务描述，队员名只是锦上添花，所以缺了不致命。
 */
function memberNameOf(
  request: SubagentStartRequestLike,
  quota: SquadQuota,
): string | undefined {
  const persona = (request.persona ?? request.descriptor?.persona)?.trim()
  if (persona === undefined || persona.length === 0) return undefined
  // persona = 职责说明 + Vela 追加的结束约定，所以反查是「全等或以前缀开头」
  // 两种都认（全等兼容没重新保存过的旧小队）。
  const candidates = (quota.members ?? [])
    .filter(member => member.instruction.trim().length > 0)
    .filter((member) => {
      const own = member.instruction.trim()
      return persona === own || persona.startsWith(`${own}\n`)
    })
  if (candidates.length === 0) return undefined
  // 两个队员的职责互为前缀时（「你写代码」与「你写代码并测试」），取最长的那个——
  // 最具体的才是真的。最长有并列（职责完全相同）就认不出，返回 undefined 而不猜。
  const longest = Math.max(...candidates.map(member => member.instruction.trim().length))
  const bests = candidates.filter(member => member.instruction.trim().length === longest)
  return bests.length === 1 ? bests[0]!.name : undefined
}

/**
 * 从一次派生的结果里取停止原因。
 *
 * 形状很宽松地读：这是约定俗成的字段，而读不到它的后果只是泳道上少一个
 * 标签，不该为此抛错。
 */
function stopReasonOf(result: unknown): string | undefined {
  if (typeof result !== 'object' || result === null) return undefined
  const reason = (result as { stopReason?: unknown }).stopReason
  return typeof reason === 'string' ? reason : undefined
}

/** 总结最多留多长。它显示在泳道下方，不是报告全文——全文点泳道进会话看。 */
const SUMMARY_MAX = 280

/**
 * 从一次派生的结果里取队员的总结文本。
 *
 * SubagentResult.output 是队员最后一条非空助手消息的内容块。宽松地读：形状
 * 不符时返回 undefined，泳道只是少一行总结，不该为此抛错。
 */
function summaryOf(result: unknown): string | undefined {
  if (typeof result !== 'object' || result === null) return undefined
  const output = (result as { output?: unknown }).output
  if (!Array.isArray(output)) return undefined
  const text = output
    .map((block) => {
      if (typeof block !== 'object' || block === null) return ''
      const candidate = block as { type?: unknown; text?: unknown }
      return candidate.type === 'text' && typeof candidate.text === 'string' ? candidate.text : ''
    })
    .join('\n')
    .trim()
  if (text.length === 0) return undefined
  return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX - 1)}…` : text
}
