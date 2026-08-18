/**
 * 召回：派活时把 Memory 里挑出的 Recap 放进开场消息（ADR-0027、CONTEXT.md）。
 *
 * 两条规矩决定了这一层的全部形状：
 *
 * 1. **只挑经 Gate 接受过的。** 候选集只有一种来源，因此「注入的东西凭什么
 *    可信」有一句话答案（ADR-0026）。草稿、废弃、陈旧的一律不进。
 * 2. **先给索引，再按预算展开。** 索引是一行一篇的标题清单，极小；正文按
 *    上限展开。这就是 OKF 的渐进披露，也是上下文预算控制的落点。
 *
 * 纯函数：输入候选与预算，输出要注入的文本与几个可核对的计数。读文件、
 * 自增引用计数都在上层。
 */

import type { RecapStatus, TrustLevel } from './okf-recap.ts'
import { SECTION_FACTS, isStale } from './okf-recap.ts'

/** 索引里最多列几篇。 */
export const RECALL_INDEX_LIMIT = 10

/** 正文最多展开几篇。 */
export const RECALL_EXPAND_LIMIT = 2

/** 展开的正文合计最多多少字符。 */
export const RECALL_CHAR_BUDGET = 4000

/** 一个候选复盘。字段是筛选与排序真正用到的那些，不是整篇。 */
export interface RecallCandidate {
  /** 相对记忆库根的路径，自增引用计数要用。 */
  readonly path: string
  readonly title: string
  readonly status: RecapStatus
  readonly trust: TrustLevel
  /** 这篇属于哪个 Workspace；缺失的一律不参与召回（宁可漏，不可错喂）。 */
  readonly workspace?: string
  readonly staleAfter?: string
  /** 人审时间，排序键。缺失的排在最后。 */
  readonly verifiedAt?: string
  /** 整篇正文（含客观足迹段）。 */
  readonly body: string
}

/** 一次召回的结果。 */
export interface Recall {
  /** 进索引的那些，按注入顺序。 */
  readonly indexed: readonly RecallCandidate[]
  /** 正文真被展开的那些——只有这些才自增引用计数。 */
  readonly expanded: readonly RecallCandidate[]
  /** 要注入派活文本的那一段；没有候选时为空串。 */
  readonly text: string
  /** 注入段落的字符数。 */
  readonly injectedChars: number
  /**
   * 分母：进索引那几篇正文的全文字符数。
   *
   * 取「索引里那些」而不是「展开的那些」：压缩率要回答的是「不做渐进披露、
   * 把候选全文塞进去会是多少」，而候选就是索引里那一批。
   */
  readonly sourceChars: number
}

/** 一次都没挑到。 */
const EMPTY: Recall = { indexed: [], expanded: [], text: '', injectedChars: 0, sourceChars: 0 }

/**
 * 挑出这次要召回的复盘。
 *
 * @param candidates - 记忆库里的全部复盘。
 * @param workspace - 这次派活的工作区；只挑同一个的（不做跨工作区召回）。
 * @param now - 判定陈旧用的当前时刻。
 */
export function selectRecall(
  candidates: readonly RecallCandidate[],
  workspace: string,
  now: number,
): Recall {
  const eligible = candidates
    .filter(candidate => candidate.workspace === workspace)
    // `stable` 与 human-reviewed 两个都要：一份手改过的文件可能写着 stable 却
    // 没有任何审核记录，那种「自称稳定」不该被当成人审过。
    .filter(candidate => candidate.status === 'stable' && candidate.trust === 'human-reviewed')
    .filter(candidate => !isStale(candidate.staleAfter, now))
    .sort(byNewestReview)
  if (eligible.length === 0) return EMPTY
  const indexed = eligible.slice(0, RECALL_INDEX_LIMIT)
  const expanded: RecallCandidate[] = []
  const bodies: string[] = []
  let used = 0
  for (const candidate of indexed) {
    if (expanded.length >= RECALL_EXPAND_LIMIT) break
    const insight = insightOf(candidate.body)
    if (insight.length === 0) continue
    const room = RECALL_CHAR_BUDGET - used
    if (room <= 0) break
    const clipped = clipToParagraph(insight, room)
    if (clipped.length === 0) break
    expanded.push(candidate)
    bodies.push(clipped)
    used += clipped.length
  }
  const text = render(indexed, expanded, bodies)
  return {
    indexed,
    expanded,
    text,
    injectedChars: text.length,
    sourceChars: indexed.reduce((total, candidate) => total + candidate.body.length, 0),
  }
}

/** 人审得越晚越靠前；没有人审时间的排在最后。 */
function byNewestReview(left: RecallCandidate, right: RecallCandidate): number {
  return (right.verifiedAt ?? '').localeCompare(left.verifiedAt ?? '')
}

/**
 * 一篇复盘里值得注入的部分：去掉客观足迹那一段。
 *
 * 足迹是账本——读了几次文件、跑了哪些命令。它对 Operator 有用（可核对），
 * 对下一次执行没用，而它往往比洞见还长。**注入洞见，不注入账本。**
 */
export function insightOf(body: string): string {
  const at = body.indexOf(SECTION_FACTS)
  return (at === -1 ? body : body.slice(0, at)).trim()
}

/**
 * 截到预算内，且切在段落边界上。
 *
 * 硬切在半句话上会让被注入的经验读起来像坏掉的数据，Agent 也可能照着半句话
 * 去理解。切不出任何完整段落时返回空串——一段都放不下就不如不放。
 */
export function clipToParagraph(text: string, budget: number): string {
  if (text.length <= budget) return text
  const NOTE = '\n\n（这篇已截断）'
  const room = budget - NOTE.length
  if (room <= 0) return ''
  const head = text.slice(0, room)
  const cut = head.lastIndexOf('\n\n')
  if (cut <= 0) return ''
  return `${head.slice(0, cut).trim()}${NOTE}`
}

/** 拼出要注入的那一段。 */
function render(
  indexed: readonly RecallCandidate[],
  expanded: readonly RecallCandidate[],
  bodies: readonly string[],
): string {
  const lines: string[] = ['## 以前的经验', '']
  lines.push(`这个工作区里经人验收过的复盘（${indexed.length} 篇）：`, '')
  for (const candidate of indexed) {
    const when = candidate.verifiedAt === undefined ? '' : `（${candidate.verifiedAt.slice(0, 10)}）`
    lines.push(`- ${candidate.title}${when}`)
  }
  if (expanded.length > 0) {
    lines.push('', `其中 ${expanded.length} 篇的正文如下；其余只列了标题，需要时可以自己去记忆库里读。`)
    for (const [at, candidate] of expanded.entries()) {
      lines.push('', `### ${candidate.title}`, '', bodies[at]!)
    }
  }
  return lines.join('\n')
}
