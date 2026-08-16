/**
 * Squad 的持久化：把一支小队落成 DSH 家目录里的一个 preset 目录，并读回来。
 *
 * 写入用与 Board 快照相同的原子发布（同目录临时文件 → fsync → rename），因此
 * 崩在任何一步都不会留下半份组合文件——那会让 DSH 把这支队标成 broken。
 *
 * 目录的可写位置由调用方给出。DSH 默认的可写 preset 根是 `<dshHome>/.agent-presets`
 * （ADR-0016），但路径解析是宿主的事，不是这一层的事。
 */

import { mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { writeAtomic } from './store.ts'
import type { ComposeOptions, Squad } from './squad.ts'
import {
  COMPOSITION_FILE, METADATA_FILE, POLICY_FILE, SQUAD_ID_PREFIX,
  baselineProblem, composeComposition, composeMetadata, composePolicy, parsePolicy, validateSquad,
} from './squad.ts'

/** Squad 读写的失败分类，直接决定 HTTP 状态码。 */
export type SquadErrorCode = 'not-found' | 'invalid' | 'conflict' | 'io'

/** 一次 Squad 操作的结果。 */
export type SquadResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: SquadErrorCode; readonly message: string }

/**
 * 拿基准 preset 组合文件的原文。
 *
 * 小队的组合必须建在一份完整的基准之上，否则队长手里一个工具也没有（见
 * squad.ts 开头）。抽成一个函数而不是直接读文件，因为基准在哪里是 DSH 的知识
 * （它有自己的多根优先级），而且这让测试能给一份固定基准。
 *
 * 每次写小队都重新取而不缓存：基准可能被改（它本身也只是一份文件），拿一份
 * 过期基准造出的小队会与 Operator 看到的 dsh 行为不一致。
 */
export type BaselineReader = () => Promise<string>

function ok<T>(value: T): SquadResult<T> {
  return { ok: true, value }
}

function fail<T>(code: SquadErrorCode, message: string): SquadResult<T> {
  return { ok: false, code, message }
}

/**
 * 一个 Squad 目录的集合，位于 DSH 的可写 preset 根下。
 *
 * 这里**不缓存**：目录随时可能被 Operator 手改，也可能被 DSH 的其他入口动过。
 * 每次都读盘的代价是几次 readdir，换来的是不会拿着一份过期名单去派活。
 */
export class SquadStore {
  /**
   * @param root - 可写 preset 根的绝对路径。
   * @param platform - 部署所在平台（`process.platform`）。它决定「跑命令」这项
   *   能力展开成 `pwsh` 还是 `bash`，填错会让整支队起不来（ADR-0017）。
   * @param baseline - 基准 preset 的组合原文来源。
   * @param compose - 生成组合时的旋钮。**每次写都重新取**：号牌层挂得比 Vela
   *   晚（它要等 `subagents` 服务），把它捕获成构造时的常量会让最早建的那
   *   几支队永远没有闸门。
   */
  constructor(
    readonly root: string,
    private readonly platform: string,
    private readonly baseline: BaselineReader,
    private readonly compose: () => ComposeOptions = () => ({}),
  ) {
    if (!isAbsolute(root)) {
      throw new Error(`squad root must be absolute, got ${root}`)
    }
  }

  private directoryFor(id: string): string {
    return join(this.root, id)
  }

  /**
   * 列出全部 Vela 造的小队，按 id 升序。
   *
   * 只认 `vela-` 前缀的目录：这个根下还住着 Operator 自己写的 preset，那些不是
   * Vela 的资产，列出来会让「删除」变成一个危险按钮。
   */
  async list(): Promise<readonly Squad[]> {
    let entries: string[]
    try {
      entries = await readdir(this.root)
    } catch {
      // 根不存在 = 还没有任何小队。这是全新安装的常态，不是错误。
      return []
    }
    const out: Squad[] = []
    for (const id of entries.filter(name => name.startsWith(SQUAD_ID_PREFIX)).sort()) {
      const squad = await this.read(id)
      if (squad.ok) out.push(squad.value)
    }
    return out
  }

  /** 读一支小队。 */
  async read(id: string): Promise<SquadResult<Squad>> {
    let text: string
    try {
      text = await readFile(join(this.directoryFor(id), POLICY_FILE), 'utf8')
    } catch {
      return fail('not-found', `小队 ${id} 不存在`)
    }
    const squad = parsePolicy(id, text)
    if (squad === undefined) return fail('invalid', `小队 ${id} 的定义读不出来`)
    return ok(squad)
  }

  /**
   * 写一支小队（新建或整体覆盖）。三个文件按依赖顺序写：策略最后落盘，
   * 因为它是 Vela 判断「这支队存在」的依据——先落它会让一次中断留下一支
   * 组合文件还没写好的队。
   */
  async write(squad: Squad, options: { readonly expectNew?: boolean } = {}): Promise<SquadResult<Squad>> {
    const invalid = validateSquad(squad, this.platform)
    if (invalid !== undefined) return fail('invalid', invalid)
    const directory = this.directoryFor(squad.id)
    if (options.expectNew === true) {
      const existing = await this.read(squad.id)
      if (existing.ok) return fail('conflict', `已经有一支叫 ${squad.title} 的小队了`)
    }
    // 基准先取、先校——拿不到它就不能写：一份没有基准的组合会让队长手里一个
    // 文件工具也没有，而那份小队看上去是建成功了的。宁可在这里 fail loud。
    let baseline: string
    try {
      baseline = await this.baseline()
    } catch (error) {
      return fail('io', `读不到基准 preset，建不了小队：${describe(error)}`)
    }
    const badBaseline = baselineProblem(baseline)
    if (badBaseline !== undefined) return fail('invalid', badBaseline)
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await writeAtomic(
        join(directory, COMPOSITION_FILE),
        composeComposition(squad, this.platform, baseline, this.compose()),
      )
      await writeAtomic(join(directory, METADATA_FILE), composeMetadata(squad))
      await writeAtomic(join(directory, POLICY_FILE), composePolicy(squad))
    } catch (error) {
      return fail('io', `写不进小队 ${squad.id}：${describe(error)}`)
    }
    return ok(squad)
  }

  /**
   * 删除一支小队。只删得掉 `vela-` 前缀的目录——Operator 自己手写的 preset
   * 不是 Vela 的资产。
   */
  async remove(id: string): Promise<SquadResult<undefined>> {
    if (!id.startsWith(SQUAD_ID_PREFIX)) {
      return fail('invalid', `${id} 不是 Vela 创建的小队，不能从这里删`)
    }
    const existing = await this.read(id)
    if (!existing.ok && existing.code === 'not-found') return fail('not-found', `小队 ${id} 不存在`)
    try {
      await rm(this.directoryFor(id), { recursive: true, force: true })
    } catch (error) {
      return fail('io', `删不掉小队 ${id}：${describe(error)}`)
    }
    return ok(undefined)
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
