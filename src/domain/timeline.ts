/**
 * 小队并行时间轴的记录层（票 10 / ADR-0019）。
 *
 * Vela 只记一件 DSH 记不下来的事：**一个 Run 里各个队员谁在什么时候跑**。至于某个
 * 队员具体做了哪些步骤，一笔不记——那是 DSH 的轨迹界面已经做得很好的部分，点一下
 * 泳道跳过去看。
 *
 * ## 时刻是我们自己打的，且必须这样标注
 *
 * 队员起跑与结束的时刻由 Vela 在**它自己观察到的那一刻**打上。这不是队员真正起跑
 * 的时刻——差值是派发延迟，进程内可忽略，但这是近似值，**不能拿去做性能归因**。
 * UI 上必须照实说明。
 *
 * ## 为什么记在内存里，不落盘
 *
 * 与实时 token 用量同一套路（ADR-0011：在途状态不落盘）。时间轴是一次观察的产物，
 * 观察者重启了就没有了——ADR-0019 已经承认「漏掉的起跑事件无法追补」，那么把一份
 * 残缺的观察持久化下来只会让人以为它是完整的。
 *
 * 代价写在这里：**进程重启后已有的时间轴会消失**，卡片与 Run 记录不受影响。
 *
 * ## 上限：一个 Run 最多记多少条
 *
 * 有上限，因为队长理论上可以派出任意多个队员，而这份记录活在内存里。超过上限后
 * **丢最新的而不是最旧的**：时间轴的价值在于「一开始的并行结构长什么样」，掐掉头
 * 会让整张图失去基准。
 */

/** 一个队员在一次 Run 里占据的时间段。 */
export interface MemberSpan {
  /**
   * DSH 给这次派生的运行 id。用它去重与配对结束事件——同一个队员可以被派出多次，
   * 名字与任务描述都可能重复，只有这个是唯一的。
   */
  readonly runId: string
  /** 队员自己的会话 id。点泳道跳过去看的就是它。 */
  readonly sessionId: string
  /** 队长给这次委派写的任务描述。比队员名更有信息量，因此是泳道的主标签。 */
  readonly label: string
  /** 队员名；从职责说明反查得到，查不到时缺省。 */
  readonly member: string | undefined
  /** **Vela 观察到的**起跑时刻。 */
  readonly observedStart: number
  /** **Vela 观察到的**结束时刻；还在跑时缺省。 */
  readonly observedEnd: number | undefined
  /** DSH 给出的停止原因；还在跑时缺省。 */
  readonly stopReason: string | undefined
  /**
   * 队员结束时写的一句话总结（它最后一条助手消息的文本）。
   * 还在跑、或队员什么也没说时缺省。验收卡片时先看这个，不用翻整场会话。
   */
  readonly summary?: string
}

/** 一个 Run 最多记多少条泳道。 */
export const MAX_SPANS_PER_RUN = 64

/** 一条新开的泳道所需的事实。 */
export interface SpanStart {
  readonly runId: string
  readonly sessionId: string
  readonly label: string
  readonly member: string | undefined
  readonly at: number
}

/**
 * 按父会话分组的时间轴记录。
 *
 * key 是**父会话 id**而不是 Vela 的 Run id：记录发生在队员起跑的路径上，那里手里
 * 有的是父 agent，而父 agent 与会话是同一个身份。Board 侧按会话 id 关联回 Run。
 */
export class TimelineRecorder {
  private readonly byParent = new Map<string, MemberSpan[]>()

  /**
   * 记下一个队员起跑。
   *
   * 同一个 runId 重复上报时**忽略后来的那次**：起跑时刻只有第一次是真的，重复上报
   * 通常意味着上游重试了什么，而覆盖会让这条泳道的起点往后跳。
   */
  start(parentSessionId: string, span: SpanStart): void {
    const spans = this.byParent.get(parentSessionId) ?? []
    if (spans.length === 0) this.byParent.set(parentSessionId, spans)
    if (spans.some(existing => existing.runId === span.runId)) return
    // 满了就丢新的。时间轴的价值在于最初的并行结构，掐掉头会让整张图失去基准。
    if (spans.length >= MAX_SPANS_PER_RUN) return
    spans.push({
      runId: span.runId,
      sessionId: span.sessionId,
      label: span.label,
      member: span.member,
      observedStart: span.at,
      observedEnd: undefined,
      stopReason: undefined,
    })
  }

  /**
   * 记下一个队员结束。找不到对应的起跑就**什么也不做**——那意味着起跑发生在这个
   * 进程之前（ADR-0019：漏掉的起跑事件无法追补），凭空造一条没有起点的泳道会画出
   * 一个假的时间段。
   */
  end(parentSessionId: string, runId: string, at: number, stopReason: string | undefined, summary?: string): void {
    const spans = this.byParent.get(parentSessionId)
    if (spans === undefined) return
    const index = spans.findIndex(span => span.runId === runId)
    if (index < 0) return
    const span = spans[index]!
    // 已经结束过就不再改：第一次结束才是真的。
    if (span.observedEnd !== undefined) return
    spans[index] = {
      ...span,
      observedEnd: at,
      stopReason,
      ...(summary === undefined || summary.trim().length === 0 ? {} : { summary }),
    }
  }

  /** 一个父会话的全部泳道，按观察到的起跑时刻升序。 */
  spansFor(parentSessionId: string): readonly MemberSpan[] {
    const spans = this.byParent.get(parentSessionId)
    if (spans === undefined) return []
    return [...spans].sort((left, right) => left.observedStart - right.observedStart)
  }

  /** 全部有记录的父会话 id。Board 视图据此只带上真的有泳道的那些。 */
  parents(): readonly string[] {
    return [...this.byParent.keys()]
  }

  /** 丢掉一个父会话的记录。卡片被删时调，免得内存里攒下永远不会被看的泳道。 */
  forget(parentSessionId: string): void {
    this.byParent.delete(parentSessionId)
  }
}

/** 一条泳道在时间轴上的几何位置，两个值都是 0–100 的百分比。 */
export interface SpanGeometry {
  /** 左边缘。 */
  readonly offset: number
  /** 宽度。**永远大于 0**——见下。 */
  readonly width: number
}

/** 一条泳道最小占多宽（百分比）。 */
const MIN_WIDTH = 1.5

/**
 * 把一批泳道摊到同一根时间轴上。
 *
 * @param spans - 泳道，顺序不重要。
 * @param now - 当前时刻，用于给还在跑的泳道画到「现在」。
 * @returns 与输入等长、一一对应的几何数组。
 *
 * 两个刻意的取舍：
 *
 * **还在跑的泳道画到 `now`**，于是时间轴会随轮询增长，跑完后定格。
 *
 * **宽度有下限。** 一个 30ms 就结束的队员在一根 5 分钟长的轴上是 0.1%，渲出来是
 * 一条看不见的线——而「它跑过而且很快」正是要传达的信息。
 */
export function layoutSpans(spans: readonly MemberSpan[], now: number): readonly SpanGeometry[] {
  if (spans.length === 0) return []
  const start = Math.min(...spans.map(span => span.observedStart))
  const end = Math.max(...spans.map(span => span.observedEnd ?? now))
  // 全部落在同一毫秒时跨度为 0。给一个正的兜底，免得除以 0。
  const total = Math.max(end - start, 1)
  return spans.map((span) => {
    const spanEnd = span.observedEnd ?? now
    const offset = ((span.observedStart - start) / total) * 100
    const width = Math.max(((spanEnd - span.observedStart) / total) * 100, MIN_WIDTH)
    // 下限撑宽后可能越过右边界；往左推回来，保持「不超出轴」这个视觉不变量。
    return { offset: Math.min(offset, 100 - width), width }
  })
}
