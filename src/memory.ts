/**
 * 记忆库的宿主侧（ADR-0022）。领域层决定「一篇复盘长什么样」，这一层决定
 * 「它落在磁盘哪里、什么时候落」。
 *
 * 三条纪律：
 *
 * 1. **路径必须显式配置。** 没配 `memoryPath` 时这个类根本不会被建出来，
 *    一个目录都不创建（ADR-0022）。不回落 `process.cwd()`，不猜 DSH 家目录。
 * 2. **写入串行化。** 一次落盘要动三个文件（复盘、索引、更新历史），并发
 *    交错会让索引对不上真相。写链与 `BoardStore` 同款。
 * 3. **索引可再生，更新历史只追加。** 索引每次整份重算——一份能被重算出来
 *    的东西不值得为它维护增量正确性。更新历史重算不出来（谁在哪天删了哪一
 *    篇，删完就没痕迹了），所以只追加、读不懂时报错而不是覆盖。
 *
 * 落盘失败一律**向上抛**，由调用方决定要不要吞。这一层不知道「一篇复盘没写
 * 成不该拖垮 Run 结算」这条策略——那是执行器的事。
 */

import { mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { writeAtomic } from './domain/store.ts'
import type { RecapDelivery, RunFacts, Recap } from './domain/okf-recap.ts'
import {
  OPERATOR_ACTOR, buildRecap, bumpUsageCount, isStale, markDeprecated, markVerified,
  readRecap, recapRelativePath, workspaceSlug,
} from './domain/okf-recap.ts'
import type { BundleEntry, BundleGroup } from './domain/okf-bundle.ts'
import {
  appendLogEntry, buildRootIndex, buildWorkspaceIndex, logPath, loggedDeprecated, loggedLanded,
  loggedRemoved, loggedVerified, readLogLines, rootIndexPath, workspaceIndexPath,
} from './domain/okf-bundle.ts'

/**
 * 写进 `generated.by` 的版本号。
 *
 * 与 `package.json` 的 version 保持一致。漂了只影响复盘里记的生成者版本，
 * 不影响任何行为——因此这里用常量而不是运行时读 package.json（那会让构建
 * 产物依赖一个它不一定能解析到的路径）。
 */
export const VELA_VERSION = '0.1.0'

/** 记忆库读写失败。 */
export class MemoryError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'MemoryError'
  }
}

/** 磁盘上的一篇复盘。读不懂时 `problem` 有值而 `recap` 没有。 */
export interface StoredRecap {
  /** 相对记忆库根的路径。 */
  readonly path: string
  readonly recap?: Recap
  /** 读不懂的原因。要显示成「这篇读不了」而不是从列表里消失（ADR-0023）。 */
  readonly problem?: string
}

/** 执行器落盘一篇复盘所需要的窄接口。测试用内存 fake 驱动。 */
export interface MemoryWriter {
  /**
   * 落下一篇复盘。返回它的相对路径。
   * @param facts - Vela 自己数出来的事实。
   * @param delivery - Agent 交付的三段；缺失表示它没按格式收尾。
   * @param at - 落盘时刻。
   */
  landRecap(facts: RunFacts, delivery: RecapDelivery | undefined, at: number): Promise<string>
}

/** 一个打开的记忆库。 */
export class MemoryStore implements MemoryWriter {
  /** 写链尾。每次写挂在前一次之后，保证三个文件的更新不交错。 */
  private tail: Promise<unknown> = Promise.resolve()

  private constructor(readonly root: string) {}

  /**
   * 打开一个记忆库。
   *
   * **不创建目录**：物化推迟到第一次真的写入。一个空目录会让 Operator 以为
   * 功能已经在跑了，而此刻还没有任何复盘。
   *
   * @param root - 绝对目录路径。相对路径直接拒绝（ADR-0022）。
   */
  static open(root: string): MemoryStore {
    if (!isAbsolute(root)) {
      throw new MemoryError(`记忆库路径必须是绝对路径，收到的是 ${root}`)
    }
    return new MemoryStore(root)
  }

  /** 把一次写排到链尾。上一次失败不能卡住下一次。 */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task, task)
    this.tail = next.catch(() => undefined)
    return next
  }

  private absolute(relative: string): string {
    return join(this.root, relative)
  }

  /** 读一个文件；不存在时 undefined。 */
  async readFileAt(relative: string): Promise<string | undefined> {
    try {
      return await readFile(this.absolute(relative), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw new MemoryError(`读不了 ${relative}`, { cause: error })
    }
  }

  /** 原子写一个文件，父目录按需创建。 */
  private async writeFileAt(relative: string, text: string): Promise<void> {
    const path = this.absolute(relative)
    try {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      await writeAtomic(path, text)
    } catch (error) {
      throw new MemoryError(`写不了 ${relative}`, { cause: error })
    }
  }

  /**
   * 落下一篇复盘，顺带记一行更新历史并重算索引。
   *
   * 顺序有意如此：**先写复盘**，再记历史，最后重算索引。前者是真相，后两个
   * 是派生物；中途失败时真相已经落地，索引下次落盘或下次打开记忆页时自然
   * 被重算对。
   */
  async landRecap(facts: RunFacts, delivery: RecapDelivery | undefined, at: number): Promise<string> {
    return this.enqueue(async () => {
      const relative = recapRelativePath(facts)
      const text = buildRecap({
        facts,
        ...(delivery === undefined ? {} : { delivery }),
        at,
        velaVersion: VELA_VERSION,
      })
      await this.writeFileAt(relative, text)
      await this.appendLogLine(loggedLanded(relative, facts.runSeq, facts.outcome), at)
      await this.reindex(at)
      return relative
    })
  }

  /** 追加一行更新历史。 */
  private async appendLogLine(line: string, at: number): Promise<void> {
    const existing = await this.readFileAt(logPath())
    await this.writeFileAt(logPath(), appendLogEntry(existing, line, at))
  }

  /** 追加一行更新历史（外部调用，走写链）。 */
  async log(line: string, at: number): Promise<void> {
    return this.enqueue(() => this.appendLogLine(line, at))
  }

  /**
   * 扫出全部复盘。读不懂的那些照样列出来，带上原因。
   *
   * 目录不存在时给空数组而不是报错：那只意味着还没有任何复盘落盘。
   */
  async list(): Promise<readonly StoredRecap[]> {
    const runsRoot = join(this.root, 'runs')
    let groups: string[]
    try {
      const entries = await readdir(runsRoot, { withFileTypes: true })
      groups = entries.filter(entry => entry.isDirectory()).map(entry => entry.name)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw new MemoryError('读不了记忆库目录', { cause: error })
    }
    const found: StoredRecap[] = []
    for (const slug of groups) {
      let files: string[]
      try {
        const entries = await readdir(join(runsRoot, slug), { withFileTypes: true })
        files = entries
          .filter(entry => entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'index.md')
          .map(entry => entry.name)
      } catch {
        continue
      }
      for (const file of files.sort()) {
        const relative = `runs/${slug}/${file}`
        const text = await this.readFileAt(relative)
        if (text === undefined) continue
        try {
          found.push({ path: relative, recap: readRecap(text) })
        } catch (error) {
          found.push({ path: relative, problem: error instanceof Error ? error.message : String(error) })
        }
      }
    }
    return found
  }

  /**
   * 整份重算索引。
   *
   * 读不懂的复盘不进索引（它没有可摆出来的标题与等级），但**留在磁盘上**，
   * 由记忆页单独显示成「这篇读不了」。
   */
  async reindex(at: number): Promise<void> {
    const stored = await this.list()
    const byWorkspace = new Map<string, { workspace: string; entries: BundleEntry[] }>()
    for (const item of stored) {
      const recap = item.recap
      if (recap === undefined) continue
      const workspace = recap.workspace ?? '（未记录工作区）'
      const slug = recap.workspace === undefined ? slugOfPath(item.path) : workspaceSlug(recap.workspace)
      const group = byWorkspace.get(slug) ?? { workspace, entries: [] }
      group.entries.push({
        path: item.path,
        title: recap.title.length === 0 ? item.path : recap.title,
        trust: recap.trust,
        status: recap.status,
        stale: isStale(recap.staleAfter, at),
        ...(recap.generatedAt === undefined ? {} : { generatedAt: recap.generatedAt }),
      })
      byWorkspace.set(slug, group)
    }
    const groups: BundleGroup[] = [...byWorkspace].map(([slug, group]) => ({
      slug,
      workspace: group.workspace,
      entries: group.entries,
    }))
    await this.writeFileAt(rootIndexPath(), buildRootIndex(groups, at))
    for (const group of groups) {
      await this.writeFileAt(workspaceIndexPath(group.slug), buildWorkspaceIndex(group, at))
    }
  }

  /** 一篇复盘经 Operator 验收：回写人审记录并记一行历史。 */
  async verify(relative: string, at: number, actor = OPERATOR_ACTOR): Promise<boolean> {
    return this.enqueue(async () => {
      const text = await this.readFileAt(relative)
      if (text === undefined) return false
      const next = markVerified(text, actor, at)
      if (next === text) return true
      await this.writeFileAt(relative, next)
      await this.appendLogLine(loggedVerified(relative, actor), at)
      await this.reindex(at)
      return true
    })
  }

  /** 把一篇复盘标成废弃。 */
  async deprecate(relative: string, why: string, at: number): Promise<boolean> {
    return this.enqueue(async () => {
      const text = await this.readFileAt(relative)
      if (text === undefined) return false
      const next = markDeprecated(text)
      if (next === text) return true
      await this.writeFileAt(relative, next)
      await this.appendLogLine(loggedDeprecated(relative, why), at)
      await this.reindex(at)
      return true
    })
  }

  /** 召回展开了一篇，把它的引用计数加上。 */
  async countUse(relative: string, at: number): Promise<void> {
    return this.enqueue(async () => {
      const text = await this.readFileAt(relative)
      if (text === undefined) return
      await this.writeFileAt(relative, bumpUsageCount(text, at))
    })
  }

  /** 删掉一篇复盘。删除必须留痕（票 06）。 */
  async remove(relative: string, at: number, actor = OPERATOR_ACTOR): Promise<boolean> {
    return this.enqueue(async () => {
      const path = this.absolute(relative)
      try {
        await rm(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw new MemoryError(`删不掉 ${relative}`, { cause: error })
      }
      await this.appendLogLine(loggedRemoved(relative, actor), at)
      await this.reindex(at)
      return true
    })
  }

  /** 更新历史里的条目，最新的在前。读不懂时给空数组。 */
  async history(): Promise<readonly string[]> {
    const text = await this.readFileAt(logPath())
    return text === undefined ? [] : readLogLines(text)
  }
}

/** 从相对路径里取出目录名。给那些没记工作区的旧文件兜底。 */
function slugOfPath(relative: string): string {
  return relative.split('/')[1] ?? 'unknown'
}
