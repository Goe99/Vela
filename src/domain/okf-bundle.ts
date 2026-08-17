/**
 * 知识包的两份账本：索引与更新历史（OKF 的 `index.md` 与 `log.md`）。
 *
 * 两者都是**可再生的派生物**：真相是那一篇篇 Recap 文件，这里只是把它们
 * 摆出来。因此索引永远整份重写而不是增量修补——一份能被重算出来的东西
 * 不值得为它维护增量正确性。
 *
 * 更新历史是唯一的例外：它记的是「发生过什么」，重算不出来（谁在哪天删了
 * 哪一篇，删完之后就没有痕迹了），所以它只追加。
 *
 * 全是纯字符串函数。读文件、写文件、决定什么时候写，都在上层。
 */

import type { Frontmatter, OkfValue } from './okf-frontmatter.ts'
import { parseDocument, serializeDocument } from './okf-frontmatter.ts'
import { OKF_VERSION, toDateStamp } from './okf-recap.ts'
import type { RecapStatus, TrustLevel } from './okf-recap.ts'

/** 索引里的一条。 */
export interface BundleEntry {
  /** 相对知识包根的路径，比如 `runs/vela-1a2b3c4d/12-r1.md`。 */
  readonly path: string
  readonly title: string
  readonly trust: TrustLevel
  readonly status: RecapStatus
  readonly stale: boolean
  /** 落盘时间（ISO），缺失表示这篇没写 `generated.at`。 */
  readonly generatedAt?: string
}

/** 一个 Workspace 下的全部条目。 */
export interface BundleGroup {
  /** 目录名（`workspaceSlug` 的结果）。 */
  readonly slug: string
  /** 那个 Workspace 的绝对路径，给人看的。 */
  readonly workspace: string
  readonly entries: readonly BundleEntry[]
}

/** 信任等级的一眼可读标记。文字而非图标：索引也会被 Agent 读到。 */
export function trustMark(trust: TrustLevel): string {
  switch (trust) {
    case 'human-reviewed': return '人审过'
    case 'machine-confirmed': return '机器确认'
    default: return '未验证'
  }
}

/**
 * 知识包的根索引。
 *
 * 只到 Workspace 一层就停：往下是每个 Workspace 自己的索引。这就是 OKF 的
 * 渐进披露——读的人（人或 Agent）先看到极小的一张目录，再决定展开哪一层。
 */
export function buildRootIndex(groups: readonly BundleGroup[], at: number): string {
  const frontmatter = new Map<string, OkfValue>([
    ['type', 'Index'],
    ['title', 'Vela 记忆库'],
    ['description', '每次执行结束落一篇复盘；信任等级由验收闸门裁定。'],
    ['okf_version', OKF_VERSION],
    ['generated', { at: new Date(at).toISOString() }],
  ])
  const lines: string[] = ['# Vela 记忆库', '']
  if (groups.length === 0) {
    lines.push('（还没有任何复盘。）')
  } else {
    lines.push('| 工作区 | 篇数 | 人审过 | 索引 |', '| --- | --- | --- | --- |')
    for (const group of groups) {
      const reviewed = group.entries.filter(entry => entry.trust === 'human-reviewed').length
      lines.push(`| \`${group.workspace}\` | ${group.entries.length} | ${reviewed} `
        + `| [${group.slug}](./runs/${group.slug}/index.md) |`)
    }
  }
  return serializeDocument({ frontmatter, body: lines.join('\n') })
}

/**
 * 一个 Workspace 的索引。
 *
 * 排序：人审过的在前、同组内新的在前。索引本身就是召回时最先注入的东西，
 * 顺序即优先级。
 */
export function buildWorkspaceIndex(group: BundleGroup, at: number): string {
  const frontmatter = new Map<string, OkfValue>([
    ['type', 'Index'],
    ['title', `记忆：${group.workspace}`],
    ['description', `${group.entries.length} 篇复盘`],
    ['generated', { at: new Date(at).toISOString() }],
  ])
  const lines: string[] = [`# 记忆：${group.workspace}`, '']
  const sorted = [...group.entries].sort(compareEntries)
  if (sorted.length === 0) {
    lines.push('（这个工作区还没有复盘。）')
  } else {
    for (const entry of sorted) {
      const marks = [trustMark(entry.trust)]
      if (entry.status === 'deprecated') marks.push('已废弃')
      if (entry.stale) marks.push('已陈旧')
      const when = entry.generatedAt === undefined ? '' : ` · ${entry.generatedAt.slice(0, 10)}`
      lines.push(`- [${entry.title}](../../${entry.path}) — ${marks.join(' · ')}${when}`)
    }
  }
  return serializeDocument({ frontmatter, body: lines.join('\n') })
}

/** 人审过的在前，其次新的在前。 */
function compareEntries(left: BundleEntry, right: BundleEntry): number {
  const weight = (entry: BundleEntry): number => (entry.trust === 'human-reviewed' ? 0 : 1)
  const byTrust = weight(left) - weight(right)
  if (byTrust !== 0) return byTrust
  return (right.generatedAt ?? '').localeCompare(left.generatedAt ?? '')
}

/** 更新历史的标题。 */
const LOG_TITLE = '# 更新历史'

/** 一份空的更新历史。 */
export function emptyLog(at: number): string {
  const frontmatter = new Map<string, OkfValue>([
    ['type', 'Log'],
    ['title', 'Vela 记忆库的更新历史'],
    ['generated', { at: new Date(at).toISOString() }],
  ])
  return serializeDocument({ frontmatter, body: LOG_TITLE })
}

/**
 * 往更新历史里追加一行，新的在前。
 *
 * 已存在的文件读不懂时**不覆盖**，而是抛错交给上层——更新历史是唯一重算
 * 不出来的东西，把它整份重写等于把「发生过什么」抹掉。
 *
 * @param existing - 现有文件内容；`undefined` 表示还没有这个文件。
 * @param line - 要记的一句话，不带列表标记。
 * @param at - 这件事发生的时刻。
 */
export function appendLogEntry(existing: string | undefined, line: string, at: number): string {
  const source = existing === undefined || existing.trim().length === 0 ? emptyLog(at) : existing
  const { frontmatter, body } = parseDocument(source)
  const stamp = toDateStamp(at)
  const time = new Date(at).toISOString().slice(11, 16)
  const bullet = `- ${time} ${line}`
  const lines = body.split('\n')
  const heading = `## ${stamp}`
  const existingDay = lines.findIndex(current => current.trim() === heading)
  if (existingDay !== -1) {
    // 同一天：插在这一天的第一条之前，当天也是新的在前。
    let insertAt = existingDay + 1
    while (insertAt < lines.length && lines[insertAt]!.trim().length === 0) insertAt += 1
    lines.splice(insertAt, 0, bullet)
    return serializeDocument({ frontmatter, body: lines.join('\n') })
  }
  // 新的一天：插在标题之后、已有各天之前。
  const titleAt = lines.findIndex(current => current.trim() === LOG_TITLE)
  const insertAt = titleAt === -1 ? 0 : titleAt + 1
  lines.splice(insertAt, 0, '', heading, '', bullet)
  return serializeDocument({ frontmatter, body: lines.join('\n') })
}

/** 一篇 Recap 落盘时记的那句话。 */
export function loggedLanded(path: string, runSeq: number, outcome: string): string {
  return `落下 \`${path}\`（第 ${runSeq} 次执行，${outcome}）`
}

/** 一篇 Recap 被人审过时记的那句话。 */
export function loggedVerified(path: string, actor: string): string {
  return `\`${path}\` 经 ${actor} 验收`
}

/** 一篇 Recap 被标废弃时记的那句话。 */
export function loggedDeprecated(path: string, why: string): string {
  return `\`${path}\` 标为废弃（${why}）`
}

/** 一篇 Recap 被删掉时记的那句话。删除必须留痕（票 06）。 */
export function loggedRemoved(path: string, actor: string): string {
  return `\`${path}\` 被 ${actor} 删除`
}

/** 读出更新历史里的全部条目，最新的在前。给记忆页用。 */
export function readLogLines(text: string): readonly string[] {
  let body: string
  try {
    body = parseDocument(text).body
  } catch {
    return []
  }
  return body.split('\n').filter(line => line.trimStart().startsWith('- ')).map(line => line.trim().slice(2))
}

/** 索引文件在知识包里的相对路径。 */
export function rootIndexPath(): string {
  return 'index.md'
}

/** 某个 Workspace 索引的相对路径。 */
export function workspaceIndexPath(slug: string): string {
  return `runs/${slug}/index.md`
}

/** 更新历史的相对路径。 */
export function logPath(): string {
  return 'log.md'
}

/** 读一份索引的 frontmatter，用于确认这是不是 Vela 写的知识包。 */
export function isVelaBundle(frontmatter: Frontmatter): boolean {
  return frontmatter.get('okf_version') === OKF_VERSION
}
