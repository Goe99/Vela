/**
 * Recap 的领域模型：一次 Run 结束后落成的一篇记忆（见 CONTEXT.md）。
 *
 * 一篇 Recap 在磁盘上是一份 OKF 概念文档。这里管三件事：
 *
 * 1. **信任等级是推导出来的，不是存下来的。** OKF 只记客观信号（谁生成、
 *    谁审过、何时），等级由信号算出。存一个 `trust: human-reviewed` 字段
 *    会让「谁写的谁说自己可信」变成可能——而 Agent 也能写文件里的字。
 * 2. **正文分两半。** 前三段来自 Agent 的收尾交付，最后一段是 Vela 自己
 *    从会话事件里数出来的客观足迹。分开是因为两半的可信度不同：一半是
 *    模型的自述，另一半是账本。
 * 3. **Agent 写的信任字段一律丢弃**（ADR-0021）。它有权交付内容，无权
 *    宣布这份内容可信。
 *
 * 全是纯函数：输入字符串与事实，输出字符串。落盘由上层做。
 */

import type { RunOutcome, TokenUsage } from './types.ts'
import type { Frontmatter, OkfRecord, OkfValue } from './okf-frontmatter.ts'
import {
  parseDocument, serializeDocument, readList, readRecord, readRecords, readString,
} from './okf-frontmatter.ts'

/** 本轮唯一的概念类型。 */
export const RECAP_TYPE = 'Run Summary'

/** 落盘时声明的规范版本。 */
export const OKF_VERSION = '0.2'

/** 一篇 Recap 多久之后算陈旧。常量而非配置：见 spec 的取舍。 */
export const STALE_AFTER_DAYS = 90

/** Vela 作为生成者的 actor 名前缀（OKF 约定 `<producer>/<version>`）。 */
export const VELA_ACTOR_PREFIX = 'vela/'

/** 人类 actor 的前缀（OKF 约定 `human:<id>`）。 */
export const HUMAN_ACTOR_PREFIX = 'human:'

/** 唯一的那个人（ADR-0001：Vela 里只有一个 Operator）。 */
export const OPERATOR_ACTOR = `${HUMAN_ACTOR_PREFIX}operator`

/**
 * 一篇 Recap 此刻可不可信。**推导值**，不落字段。
 *
 * `machine-confirmed` 本轮不会被 Vela 产生（没有确定性 attester），但读别人
 * 的知识包时会遇到，因此推导必须认得它。
 */
export type TrustLevel = 'unverified' | 'machine-confirmed' | 'human-reviewed'

/** 全部信任等级，由弱到强。校验外来数据时要用到它。 */
export const TRUST_LEVELS: readonly TrustLevel[] = ['unverified', 'machine-confirmed', 'human-reviewed']

/** 生命周期状态（OKF 的 `status`）。与信任等级正交，各管一件事。 */
export type RecapStatus = 'draft' | 'stable' | 'deprecated'

/** 全部生命周期状态。 */
export const RECAP_STATUSES: readonly RecapStatus[] = ['draft', 'stable', 'deprecated']

/** Agent 在收尾块里交付的三段。 */
export interface RecapDelivery {
  readonly conclusion: string
  readonly did: string
  readonly pitfalls: string
}

/** 一个文件在这次执行里被碰过几次。 */
export interface FileTouch {
  readonly path: string
  readonly reads: number
  readonly writes: number
}

/** 召回在这次执行里注入了多少（票 07 填；没有召回时缺失）。 */
export interface RecallFacts {
  /** 索引里列了几篇。 */
  readonly indexed: number
  /** 正文真正展开了几篇。 */
  readonly expanded: number
  /** 注入段落的字符数。 */
  readonly injectedChars: number
  /** 被选中那几篇正文的全文字符数——压缩率的分母。 */
  readonly sourceChars: number
}

/** Vela 自己数得出来的全部事实。缺失一律表示未知，不伪造成 0。 */
export interface RunFacts {
  readonly issueNumber: number
  /** 这是这张卡的第几次执行，1 起。 */
  readonly runSeq: number
  readonly sessionId: string
  readonly workspace: string
  readonly title: string
  readonly outcome: RunOutcome
  readonly failure?: string
  readonly startedAt: number
  readonly endedAt: number
  readonly usage?: TokenUsage
  readonly files: readonly FileTouch[]
  /** 跑过的命令（原文，超长的由调用方截断）。 */
  readonly commands: readonly string[]
  readonly recall?: RecallFacts
}

/** 一篇读出来的 Recap。 */
export interface Recap {
  readonly frontmatter: Frontmatter
  readonly body: string
  readonly type: string
  readonly title: string
  readonly status: RecapStatus
  readonly trust: TrustLevel
  readonly tags: readonly string[]
  readonly staleAfter?: string
  readonly generatedAt?: string
  /** 最近一次人审的时间，没审过则缺失。 */
  readonly verifiedAt?: string
  /** 被召回展开过几次（`sources[0].usage_count`）。 */
  readonly usageCount: number
  /** 这篇属于哪个 Workspace（给索引与召回筛选用）。 */
  readonly workspace?: string
  /** 卡号，缺失表示这篇不是 Vela 写的。 */
  readonly issueNumber?: number
}

/** 判断一个 actor 是不是人。 */
export function isHumanActor(actor: string): boolean {
  return actor.startsWith(HUMAN_ACTOR_PREFIX)
}

/**
 * 从溯源字段推导信任等级。
 *
 * 人审过就是 human-reviewed，哪怕同时有机器确认——人的判断是更强的信号，
 * 不是被机器的那条冲淡。
 */
export function trustLevelOf(verified: readonly OkfRecord[]): TrustLevel {
  let machine = false
  for (const entry of verified) {
    const by = entry.by
    if (typeof by !== 'string' || by.length === 0) continue
    if (isHumanActor(by)) return 'human-reviewed'
    machine = true
  }
  return machine ? 'machine-confirmed' : 'unverified'
}

/** 一个 `YYYY-MM-DD`（UTC）。OKF 要求绝对日期，不存相对期限。 */
export function toDateStamp(at: number): string {
  return new Date(at).toISOString().slice(0, 10)
}

/** 落盘时该写的 `stale_after`。 */
export function staleAfterFor(at: number): string {
  return toDateStamp(at + STALE_AFTER_DAYS * 24 * 60 * 60 * 1000)
}

/**
 * 到 `now` 这一刻算不算陈旧。
 *
 * `stale_after` 读作「这一天之后陈旧」，因此**到期当天还不陈旧**——一份写着
 * 今天的知识今天仍然作数，边界含在有效期内。日期读不出来时按不陈旧处理：
 * 缺一个可选字段不该让一篇知识失效（OKF 要求消费者容忍缺失字段）。
 */
export function isStale(staleAfter: string | undefined, now: number): boolean {
  if (staleAfter === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(staleAfter)) return false
  return toDateStamp(now) > staleAfter
}

/**
 * 一个 Workspace 绝对路径对应的目录名。
 *
 * 取目录名加上整条路径的短哈希：只用目录名会让两个都叫 `web` 的仓库撞进
 * 同一个目录，只用哈希则人看不出这堆记忆属于哪个项目。
 */
export function workspaceSlug(workspace: string): string {
  const normalized = workspace.replace(/[\\/]+$/, '')
  const base = normalized.split(/[\\/]/).pop() ?? ''
  const cleaned = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return `${cleaned.length === 0 ? 'workspace' : cleaned}-${shortHash(normalized)}`
}

/**
 * 路径的 8 位十六进制指纹（FNV-1a）。
 *
 * 自己算而不是用 `node:crypto`：这一层要能在任何环境下跑，而这里要的只是
 * 「同一条路径每次得到同一个短名字」，不是抗碰撞。
 */
function shortHash(text: string): string {
  let hash = 0x811c9dc5
  for (let at = 0; at < text.length; at += 1) {
    hash ^= text.charCodeAt(at)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** 一篇 Recap 在知识包里的相对路径。 */
export function recapRelativePath(facts: Pick<RunFacts, 'workspace' | 'issueNumber' | 'runSeq'>): string {
  return `runs/${workspaceSlug(facts.workspace)}/${facts.issueNumber}-r${facts.runSeq}.md`
}

/** 正文四段的固定小标题。前三段来自 Agent，末段来自 Vela。 */
export const SECTION_CONCLUSION = '## 结论'
export const SECTION_DID = '## 做了什么'
export const SECTION_PITFALLS = '## 坑与注意'
export const SECTION_FACTS = '## 客观足迹'

/** 收尾块的围栏语言标记。 */
export const DELIVERY_FENCE = 'vela-recap'

/** Agent 没交付收尾块时正文里的说明。不伪造内容（ADR-0021）。 */
export const NO_DELIVERY_NOTE = '（这次没有交付收尾块）'

/** 非成功收尾时正文里的说明。 */
export function noDeliveryNoteFor(outcome: RunOutcome): string {
  switch (outcome) {
    case 'timeout': return '（这次执行超时被中断，没有收尾交付）'
    case 'aborted': return '（这次执行被取消，没有收尾交付）'
    case 'interrupted': return '（上一次进程结束时这次执行仍在进行，结果未知）'
    case 'error': return '（这次执行报错结束，没有收尾交付）'
    case 'blocked': return '（这次执行被挡住，没有收尾交付）'
    case 'max-tokens': return '（这次执行撞到 token 上限，没有收尾交付）'
    default: return NO_DELIVERY_NOTE
  }
}

/**
 * 从 Agent 最后一条回复的正文里切出收尾块。
 *
 * 认围栏而不认裸小标题：围栏是会话文本里稳定可识别的边界（`extract.ts` 的
 * 同一个理由），而且围栏里的字不会被 Operator 误读成对他说的话。有多个时
 * 取**最后一个**——模型常先举例说明格式，真正的交付在最后。
 *
 * @param text - assistant 消息里拼起来的文本。
 * @returns 三段内容；没有围栏块或块里一段都没有时 undefined。
 */
export function extractDelivery(text: string): RecapDelivery | undefined {
  const fence = new RegExp(`^[ \\t]*(?:\`{3,}|~{3,})${DELIVERY_FENCE}[ \\t]*$`, 'm')
  let rest = text
  let block: string | undefined
  for (;;) {
    const opened = fence.exec(rest)
    if (opened === null) break
    const after = rest.slice(opened.index + opened[0].length)
    const closed = /^[ \t]*(?:`{3,}|~{3,})[ \t]*$/m.exec(after)
    block = closed === null ? after : after.slice(0, closed.index)
    rest = closed === null ? '' : after.slice(closed.index + closed[0].length)
    if (rest.length === 0) break
  }
  if (block === undefined) return undefined
  const conclusion = sectionOf(block, SECTION_CONCLUSION)
  const did = sectionOf(block, SECTION_DID)
  const pitfalls = sectionOf(block, SECTION_PITFALLS)
  if (conclusion.length === 0 && did.length === 0 && pitfalls.length === 0) return undefined
  return { conclusion, did, pitfalls }
}

/** 取一段 Markdown 里某个二级标题下的内容，到下一个二级标题为止。 */
export function sectionOf(text: string, heading: string): string {
  const lines = text.split('\n')
  const start = lines.findIndex(line => line.trim() === heading)
  if (start === -1) return ''
  const collected: string[] = []
  for (let at = start + 1; at < lines.length; at += 1) {
    if (/^##\s/.test(lines[at]!.trim())) break
    collected.push(lines[at]!)
  }
  return collected.join('\n').trim()
}

/** 组装一篇 Recap 的入参。 */
export interface BuildRecapInput {
  readonly facts: RunFacts
  /** Agent 交付的三段；缺失表示它没按格式收尾。 */
  readonly delivery?: RecapDelivery
  /** 落盘时刻。 */
  readonly at: number
  /** 生成者版本，写进 `generated.by`。 */
  readonly velaVersion: string
}

/**
 * 组装一篇 Recap 的完整文本。
 *
 * `status` 一律 `draft`：一篇刚落盘的记忆没有经过任何人，这是它唯一诚实的
 * 状态。升级只能由 Gate 做（ADR-0025）。
 */
export function buildRecap(input: BuildRecapInput): string {
  const { facts, delivery, at, velaVersion } = input
  const actor = `${VELA_ACTOR_PREFIX}${velaVersion}`
  const iso = new Date(at).toISOString()
  const frontmatter = new Map<string, OkfValue>([
    ['type', RECAP_TYPE],
    ['title', facts.title],
    ['description', describeOutcome(facts)],
    ['status', 'draft'],
    ['tags', [
      `workspace:${workspaceSlug(facts.workspace)}`,
      `issue:${facts.issueNumber}`,
      `outcome:${facts.outcome}`,
    ]],
    ['generated', { by: actor, at: iso }],
    ['stale_after', staleAfterFor(at)],
    ['sources', [{ author: actor, usage_count: 0, last_modified: iso }]],
    ['vela_run', velaRunRecord(facts)],
  ])
  return serializeDocument({ frontmatter, body: buildBody(facts, delivery) })
}

/** 一句话结果，进 `description`。 */
function describeOutcome(facts: RunFacts): string {
  if (facts.outcome === 'completed') return `第 ${facts.runSeq} 次执行完成`
  const reason = facts.failure === undefined ? '' : `：${facts.failure}`
  return `第 ${facts.runSeq} 次执行未完成（${facts.outcome}）${reason}`
}

/**
 * 机器要读的那些事实收在一个键下。
 *
 * 扁平的标量而非嵌套结构：头部解析只认一层深（ADR-0023），而这些数字的
 * 唯一用途是被脚本汇总（票 08），扁平反而更好 grep。逐个文件的明细进正文
 * ——那是给人看的。
 */
function velaRunRecord(facts: RunFacts): OkfRecord {
  const record: Record<string, string | number> = {
    issue: facts.issueNumber,
    run_seq: facts.runSeq,
    session_id: facts.sessionId,
    // 给索引用：目录名里的短哈希不可逆，而索引要摆出人看得懂的路径。
    workspace: facts.workspace,
    outcome: facts.outcome,
    duration_ms: Math.max(0, facts.endedAt - facts.startedAt),
    repeated_reads: repeatedReadsOf(facts.files),
    files_touched: facts.files.length,
    commands_run: facts.commands.length,
  }
  // 用量缺失表示未知，不写 0（ADR-0011 的同一条态度）。
  if (facts.usage !== undefined) {
    record.input_tokens = facts.usage.inputTokens
    record.output_tokens = facts.usage.outputTokens
    record.cache_read_tokens = facts.usage.cacheReadTokens
  }
  if (facts.recall !== undefined) {
    record.recall_indexed = facts.recall.indexed
    record.recall_expanded = facts.recall.expanded
    record.injected_chars = facts.recall.injectedChars
    record.recalled_chars = facts.recall.sourceChars
  }
  return record
}

/**
 * 重复读文件次数：同一条路径第 2 次起算。
 *
 * 口径写在这里而不是散在调用点：它是要写进简历的数字，只能有一个定义。
 */
export function repeatedReadsOf(files: readonly FileTouch[]): number {
  return files.reduce((total, file) => total + Math.max(0, file.reads - 1), 0)
}

/** 正文四段。 */
function buildBody(facts: RunFacts, delivery: RecapDelivery | undefined): string {
  const fallback = delivery === undefined ? noDeliveryNoteFor(facts.outcome) : ''
  const sections = [
    `${SECTION_CONCLUSION}\n\n${delivery?.conclusion || fallback || NO_DELIVERY_NOTE}`,
    `${SECTION_DID}\n\n${delivery?.did || fallback || NO_DELIVERY_NOTE}`,
    `${SECTION_PITFALLS}\n\n${delivery?.pitfalls || fallback || NO_DELIVERY_NOTE}`,
    `${SECTION_FACTS}\n\n${buildFactsSection(facts)}`,
  ]
  return sections.join('\n\n')
}

/** 客观足迹那一段。这一段的每一个字都来自 Vela 自己数的，不来自模型。 */
function buildFactsSection(facts: RunFacts): string {
  const lines: string[] = [
    `- 结果：${facts.outcome}${facts.failure === undefined ? '' : `（${facts.failure}）`}`,
    `- 耗时：${formatDuration(Math.max(0, facts.endedAt - facts.startedAt))}`,
    `- 用量：${formatUsage(facts.usage)}`,
    `- 会话：${facts.sessionId}`,
  ]
  const repeated = repeatedReadsOf(facts.files)
  lines.push(`- 重复读文件：${repeated} 次`)
  if (facts.recall !== undefined) {
    lines.push(`- 这次注入：索引 ${facts.recall.indexed} 篇、展开 ${facts.recall.expanded} 篇、`
      + `${facts.recall.injectedChars} 字（原文 ${facts.recall.sourceChars} 字）`)
  }
  if (facts.files.length > 0) {
    lines.push('- 碰过的文件：')
    for (const file of facts.files) {
      lines.push(`  - \`${file.path}\` 读 ${file.reads} 次、写 ${file.writes} 次`)
    }
  }
  if (facts.commands.length > 0) {
    lines.push(`- 跑过的命令（${facts.commands.length} 条）：`)
    for (const command of facts.commands) lines.push(`  - \`${command}\``)
  }
  return lines.join('\n')
}

/** 人读的耗时。 */
export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  return `${minutes} 分 ${seconds % 60} 秒`
}

/** 人读的用量。缺失显示为未知，不显示 0。 */
export function formatUsage(usage: TokenUsage | undefined): string {
  if (usage === undefined) return '未知'
  return `输入 ${usage.inputTokens}（缓存读 ${usage.cacheReadTokens}）/ 输出 ${usage.outputTokens}`
}

/**
 * 读一篇 Recap。
 *
 * 解析失败时抛 `OkfParseError`——上层要把它显示成「这篇读不了」，而不是让
 * 这篇从列表里消失（ADR-0023）。
 */
export function readRecap(text: string): Recap {
  const { frontmatter, body } = parseDocument(text)
  const verified = readRecords(frontmatter, 'verified')
  const sources = readRecords(frontmatter, 'sources')
  const rawStatus = readString(frontmatter, 'status')
  const status = (RECAP_STATUSES as readonly string[]).includes(rawStatus ?? '')
    ? rawStatus as RecapStatus
    : 'draft'
  const lastVerified = [...verified].reverse().find(entry => typeof entry.by === 'string' && isHumanActor(entry.by))
  const usageCount = sources.reduce((max, source) => {
    const count = source.usage_count
    return typeof count === 'number' && count > max ? count : max
  }, 0)
  const staleAfter = readString(frontmatter, 'stale_after')
  // 用 `readRecord` 而不是手写形状判断：数组也有 `.at` 方法，直接读
  // `generated.at` 会在类型上静默通过却拿到一个函数。
  const generatedAt = readRecord(frontmatter, 'generated')?.at
  const runRecord = readRecord(frontmatter, 'vela_run')
  const workspace = runRecord?.workspace
  const issueNumber = runRecord?.issue
  return {
    frontmatter,
    body,
    type: readString(frontmatter, 'type') ?? '',
    title: readString(frontmatter, 'title') ?? '',
    status,
    trust: trustLevelOf(verified),
    tags: readList(frontmatter, 'tags'),
    ...(staleAfter === undefined ? {} : { staleAfter }),
    ...(typeof generatedAt === 'string' ? { generatedAt } : {}),
    ...(typeof lastVerified?.at === 'string' ? { verifiedAt: lastVerified.at } : {}),
    usageCount,
    ...(typeof workspace === 'string' ? { workspace } : {}),
    ...(typeof issueNumber === 'number' ? { issueNumber } : {}),
  }
}

/**
 * 往一篇 Recap 里回写人审记录，并把生命周期升为 `stable`。
 *
 * **幂等**：同一个 actor 已经在里面时不再追一条。因为对账会重复调它
 * （ADR-0025：看板是真相，文件可补齐），不幂等就会让一篇被反复对账的
 * 文档长出一堆一模一样的审核行。
 *
 * @param text - 现有文件内容。
 * @param actor - 审的人，比如 `human:operator`。
 * @param at - 审的时刻。
 */
export function markVerified(text: string, actor: string, at: number): string {
  const { frontmatter, body } = parseDocument(text)
  const verified = [...readRecords(frontmatter, 'verified')]
  const next = new Map<string, OkfValue>(frontmatter)
  if (!verified.some(entry => entry.by === actor)) {
    verified.push({ by: actor, at: new Date(at).toISOString() })
    next.set('verified', verified)
  }
  next.set('status', 'stable' satisfies RecapStatus)
  return serializeDocument({ frontmatter: next, body })
}

/**
 * 把一篇 Recap 标成废弃。
 *
 * 不删文件：被退回的那篇是反面证据，它记着「这条路试过、不通」
 * （ADR-0025）。废弃只影响能不能被召回，不影响能不能被人翻到。
 */
export function markDeprecated(text: string): string {
  const { frontmatter, body } = parseDocument(text)
  const next = new Map<string, OkfValue>(frontmatter)
  next.set('status', 'deprecated' satisfies RecapStatus)
  return serializeDocument({ frontmatter: next, body })
}

/**
 * 召回展开了一遍，把引用计数加上。
 *
 * 只在正文真的被展开时调，进索引不算（spec 的取舍：进索引只是候选，
 * 不代表被用到）。没有 `sources` 时补一条：计数要有地方落。
 */
export function bumpUsageCount(text: string, at: number): string {
  const { frontmatter, body } = parseDocument(text)
  const sources = readRecords(frontmatter, 'sources')
  const iso = new Date(at).toISOString()
  const next = new Map<string, OkfValue>(frontmatter)
  if (sources.length === 0) {
    next.set('sources', [{ author: 'unknown', usage_count: 1, last_modified: iso }])
  } else {
    next.set('sources', sources.map((source, index) => (index === 0
      ? {
        ...source,
        usage_count: (typeof source.usage_count === 'number' ? source.usage_count : 0) + 1,
        last_modified: iso,
      }
      : source)))
  }
  return serializeDocument({ frontmatter: next, body })
}
