/**
 * 技能广场的宿主侧（扫盘那一半）。形状与合并规则在 `domain/skills.ts`，
 * 这一层只管「去哪个目录、把文件读出来」。
 *
 * 与 DSH 的发现规则对齐（packages/skill/skill-filesystem）：
 * - 一个技能 = 一个含 `SKILL.md` 的子目录，或根目录下一个散装的 `.md` 文件；
 * - DSH 目录下的 `.system` 子目录跳过（DSH 自己的 skipSystem 行为）；
 * - 不存在的根不是错误——全新安装就是这样，跳过即可。
 *
 * 容错纪律与记忆库相同（ADR-0023）：一个读不懂的技能要显示成「这个读不了」，
 * 而不是从列表里悄悄消失——广场的职责就是让人看到磁盘上到底有什么。
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { mergeSkills, parseSkillHead } from './domain/skills.ts'
import type { InstalledSkill, SkillSource } from './domain/skills.ts'

/** 一个要扫的技能根。`roots` 的先后顺序即优先级（靠前的盖住同名）。 */
export interface SkillRootSpec {
  readonly path: string
  readonly source: SkillSource
}

/** 技能广场的目录扫描器。无状态，每次 list 都现扫——目录随时可能被人手改。 */
export class SkillCatalog {
  constructor(readonly roots: readonly SkillRootSpec[]) {}

  /** 扫全部根并合并成一张清单。单个根读不了不拖垮其余。 */
  async list(): Promise<readonly InstalledSkill[]> {
    const groups: InstalledSkill[][] = []
    for (const root of this.roots) {
      groups.push(await this.scanRoot(root))
    }
    return mergeSkills(groups)
  }

  private async scanRoot(root: SkillRootSpec): Promise<InstalledSkill[]> {
    let entries
    try {
      entries = await readdir(root.path, { withFileTypes: true })
    } catch {
      // 根不存在 = 这个来源一个技能也没装。全新安装的常态，不是错误。
      return []
    }
    const skills: InstalledSkill[] = []
    // 按名字排序再扫，让输出稳定可 diff（与 DSH 的发现顺序一致）。
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      // 与 DSH 对齐：`.system` 子目录不是技能（只对 dsh 根；其余根没这个例外）。
      if (root.source === 'dsh' && entry.name === '.system') continue
      const file = entry.isDirectory()
        ? join(root.path, entry.name, 'SKILL.md')
        : entry.isFile() && entry.name.endsWith('.md')
          ? join(root.path, entry.name)
          : undefined
      if (file === undefined) continue
      skills.push(await this.readSkill(file, entry.name.replace(/\.md$/, ''), root.source))
    }
    return skills
  }

  /**
   * 读一个技能文件。`fallbackName` 是目录名/文件名——技能头里读不出名字时
   * 用它顶上，让这个条目在广场上可见（DSH 能不能认它是另一回事，标出来）。
   */
  private async readSkill(file: string, fallbackName: string, source: SkillSource): Promise<InstalledSkill> {
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      return {
        name: fallbackName,
        description: '',
        userOnly: false,
        source,
        sourcePath: file,
        effective: true,
        problem: `文件读不了：${error instanceof Error ? error.message : String(error)}`,
      }
    }
    const head = parseSkillHead(text)
    if (head === undefined || head.name === undefined) {
      return {
        name: fallbackName,
        description: head?.description ?? '',
        ...(head?.whenToUse === undefined ? {} : { whenToUse: head.whenToUse }),
        userOnly: head?.userOnly ?? false,
        source,
        sourcePath: file,
        effective: true,
        problem: head === undefined ? '没有 frontmatter 头，DSH 可能认不出它' : '头部里没有 name，DSH 可能认不出它',
      }
    }
    return {
      name: head.name,
      description: head.description ?? '',
      ...(head.whenToUse === undefined ? {} : { whenToUse: head.whenToUse }),
      userOnly: head.userOnly,
      source,
      sourcePath: file,
      effective: true,
    }
  }
}
