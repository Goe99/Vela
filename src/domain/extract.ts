/**
 * 从一段会话里挑出候选待办（票 13）。
 *
 * 这一层是纯函数：输入若干段文本，输出候选行。它**不建卡**——建卡权归
 * Operator（ADR-0012），所以这里只负责「把可能是待办的行找出来摆给人看」，
 * 勾哪些是人的事。
 *
 * 为什么不做得更聪明：任何「智能」提取都会在两个方向上错——漏掉真待办，或者
 * 把代码片段、引用、闲聊捞进来。摆出候选让人勾选时，第二类错误的代价从「多了
 * 一张垃圾卡」降到「多看一眼」，因此宁可宽松地捞、严格地筛。
 */

/** 一条候选待办。 */
export interface Candidate {
  /** 清理过的标题，直接可当卡片标题用。 */
  readonly title: string
  /** 它来自第几段文本（0 起）。用来在界面上按来源分组。 */
  readonly source: number
}

/**
 * 一行最短要有几个字才算候选。
 *
 * 一两个字的清单项（「是」「好」「1」）几乎总是别的东西——表格残片、
 * 枚举值、代码里的数组元素。
 */
const MIN_TITLE_LENGTH = 4

/** 一行最长到哪就不像标题了。超过的多半是整段说明被写成了一个列表项。 */
const MAX_TITLE_LENGTH = 120

/**
 * 列表标记：`- `、`* `、`+ `、`1. `、`1) `、`（1）`。
 *
 * 刻意**不**认无标记的裸行——那会把整段散文的每一行都当成候选。
 *
 * 符号类标记（`-` `*` `+`）**必须**跟一个空白，否则 `-减去` 、`*星号` 这类
 * 行文会被当成列表。编号类标记的空白是**可选**的：中文习惯里
 * `1.先跑一遍` 与 `（1）先跑一遍` 都不加空格，而它们的标记本身已经够明确。
 */
const LIST_MARKER = /^\s{0,6}(?:[-*+]\s+|(?:\d{1,3}[.)]|（\d{1,3}）|\(\d{1,3}\))\s*)/

/** 已勾选的复选框。这些是**已完成**的事，不该再变成待办。 */
const CHECKED_BOX = /^\[[xX✓]\]\s*/

/** 未勾选的复选框，去掉标记后剩下的才是标题。 */
const UNCHECKED_BOX = /^\[\s?\]\s*/

/** 行内 markdown 强调与代码标记。留着会让卡片标题里带一堆星号反引号。 */
const INLINE_MARKS = /(\*\*|__|`|~~)/g

/** 行尾的引用式脚注与括注编号，例如 `…（见上）` 后面跟的 `[1]`。 */
const TRAILING_REF = /\s*\[\^?\d+\]\s*$/

/**
 * 把一行清理成候选标题；判定它不是候选时返回 undefined。
 * @param line - 原始一行。
 * @returns 清理后的标题，或 undefined。
 */
function titleOf(line: string): string | undefined {
  if (!LIST_MARKER.test(line)) return undefined
  let text = line.replace(LIST_MARKER, '').trim()
  // 已经打勾的不算待办——它记录的是「做完了」。
  if (CHECKED_BOX.test(text)) return undefined
  text = text.replace(UNCHECKED_BOX, '')
  text = text.replace(INLINE_MARKS, '').replace(TRAILING_REF, '').trim()
  // 只剩标点或空白的行（分隔线 `---`、表格边框）不算。
  if (!/[\p{L}\p{N}]/u.test(text)) return undefined
  if (text.length < MIN_TITLE_LENGTH || text.length > MAX_TITLE_LENGTH) return undefined
  return text
}

/**
 * 从若干段文本里挑出候选待办。
 *
 * 同一条待办在一次会话里常被重复提及（先列计划、后逐条确认），所以按标题去重，
 * 保留第一次出现的位置——那通常是它被提出来的地方。
 *
 * @param texts - 会话里的文本段，按时间顺序。
 * @returns 候选清单，按出现顺序。
 */
export function extractCandidates(texts: readonly string[]): readonly Candidate[] {
  const seen = new Set<string>()
  const found: Candidate[] = []
  for (const [source, text] of texts.entries()) {
    // 围栏代码块整段跳过：里面的 `- foo` 是 YAML 或注释，不是待办。
    for (const line of stripFences(text).split('\n')) {
      const title = titleOf(line)
      if (title === undefined) continue
      const key = title.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      found.push({ title, source })
    }
  }
  return found
}

/**
 * 去掉围栏代码块。
 *
 * 未闭合的围栏（模型输出被截断时常见）按「一直开到结尾」处理——宁可少捞几条，
 * 也不要把半个配置文件变成一堆卡片。
 *
 * @param text - 原始文本。
 * @returns 去掉围栏块后的文本。
 */
function stripFences(text: string): string {
  const kept: string[] = []
  let inside = false
  for (const line of text.split('\n')) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      inside = !inside
      continue
    }
    if (!inside) kept.push(line)
  }
  return kept.join('\n')
}
