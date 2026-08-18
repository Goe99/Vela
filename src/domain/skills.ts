/**
 * 技能广场的领域层：一个已安装技能长什么样、技能头怎么容错地读、多个来源
 * 的技能怎么按优先级并成一张清单。
 *
 * 这一层是纯函数、零 node 依赖——client bundle 也会 import 它（广场页与
 * board-client 都要这个形状），扫盘那一半在宿主侧的 `src/skills.ts`。
 *
 * ## 为什么技能头是自己读的，而不是问 DSH 要
 *
 * DSH 把宿主平面的技能扫描关掉了（web 组合的 patch 里 `skill-filesystem`
 * 是 disabled，注释写明「发现归各 preset 管」），因此宿主侧的 `ctx.skills`
 * 列不出磁盘上的技能。想看「这个部署装了哪些技能」，只能自己扫那几个目录。
 * 这也意味着这里读技能头用的是**容错**解析：读不懂的条目照样列出来并标明
 * 原因，而不是从列表里消失——广场的职责是「让人看到磁盘上有什么」，DSH
 * 自己能不能读懂它，是另一回事。
 */

/** 技能的来源目录种类。 */
export type SkillSource = 'dsh' | 'agents' | 'bundled'

/** 来源的展示顺序（也是优先级顺序：靠前的盖住靠后的同名技能）。 */
export const SKILL_SOURCES: readonly SkillSource[] = ['dsh', 'agents', 'bundled']

/** 来源的中文标签。 */
export const SKILL_SOURCE_LABELS: Readonly<Record<SkillSource, string>> = {
  dsh: 'DSH 目录',
  agents: '共享目录',
  bundled: '出厂自带',
}

/** 一个已安装的技能（广场页展示用的投影）。 */
export interface InstalledSkill {
  /** 技能名，也就是在对话里 `/name` 引用的那个名字。 */
  readonly name: string
  readonly description: string
  /** 可选的补充路由说明（frontmatter 的 when-to-use）。 */
  readonly whenToUse?: string
  /** true = 只能人手动 `/name` 调，模型看不到它（disable-model-invocation）。 */
  readonly userOnly: boolean
  readonly source: SkillSource
  /** 技能文件（SKILL.md 或散装 .md）的绝对路径。 */
  readonly sourcePath: string
  /**
   * false = 被更高优先级来源里的同名技能盖住，实际生效的不是这份。
   *
   * 注意这个判定只在广场扫到的范围内成立：工作区里的项目级技能
   * （`.dsh/skills` 等）优先级更高，但广场不扫它们（那是随工作区变的），
   * 所以一个这里标着「生效」的技能，在具体工作区里仍可能被项目级同名
   * 技能盖住。
   */
  readonly effective: boolean
  /** 技能头读不懂时的原因。条目照样列出，而不是从列表里消失。 */
  readonly problem?: string
}

/** 从技能头里容错读出来的那几个字段。 */
export interface SkillHead {
  readonly name?: string
  readonly description?: string
  readonly whenToUse?: string
  readonly userOnly: boolean
}

/** 头部与正文的分界。 */
const FENCE = '---'

/** 块标量指示符：`description: >-` 这类写法的值在后面的缩进行里。 */
const BLOCK_SCALAR = /^[>|][+-]?$/

/** 去掉标量两端的成对引号；不成对的保持原样（容错，不猜）。 */
function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0]!
    const last = value[value.length - 1]!
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1)
    }
  }
  return value
}

/**
 * 容错地读一份 SKILL.md 的头。返回 undefined 表示连 frontmatter 块都没有；
 * 否则返回读出来的字段——缺哪个字段就是 undefined，不猜默认值。
 *
 * 这里**不是**一个 YAML 实现（与 okf-frontmatter 不同，那个只管 Vela 自己
 * 写的受控子集，而技能文件是别人写的任意 YAML）。它只认一层 `key: value`
 * 加最常见的块标量，为的是把名字和描述展示给人看；技能的权威内容永远是
 * 文件本身，装配（复制）走的是逐字节，不经过这里。
 */
export function parseSkillHead(text: string): SkillHead | undefined {
  const lines = text.split(/\r?\n/)
  if (lines[0]?.trim() !== FENCE) return undefined
  let end = -1
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]?.trim() === FENCE) { end = index; break }
  }
  if (end < 0) return undefined

  let name: string | undefined
  let description: string | undefined
  let whenToUse: string | undefined
  let userOnly = false

  for (let index = 1; index < end; index += 1) {
    const line = lines[index]!
    // 顶层键：行首非空白、形如 `key:`。缩进行的键属于嵌套结构，不读。
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (match === null) continue
    const key = match[1]!
    let value = match[2]!.trim()
    // 块标量：值在后续更缩进的行里，拼成一行（展示用，换行变空格）。
    if (BLOCK_SCALAR.test(value)) {
      const parts: string[] = []
      for (let cursor = index + 1; cursor < end; cursor += 1) {
        const inner = lines[cursor]!
        if (inner.trim().length === 0) continue
        if (!/^\s/.test(inner)) break
        parts.push(inner.trim())
        index = cursor
      }
      value = parts.join(' ')
    }
    value = unquote(value)
    switch (key) {
      case 'name':
        if (value.length > 0) name = value
        break
      case 'description':
        if (value.length > 0) description = value
        break
      case 'when-to-use':
      case 'whenToUse':
        if (value.length > 0) whenToUse = value
        break
      case 'disable-model-invocation':
        userOnly = value === 'true'
        break
      default:
        break
    }
  }
  return {
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    ...(whenToUse === undefined ? {} : { whenToUse }),
    userOnly,
  }
}

/**
 * 把按优先级从高到低排好的各来源列表并成一张清单：同名先来者生效，
 * 后来者保留在列表里但标 `effective: false`（让人看到「这里还有一份，
 * 但它被盖住了」）。输出按名字排序，与来源无关。
 */
export function mergeSkills(groups: readonly (readonly InstalledSkill[])[]): readonly InstalledSkill[] {
  const out: InstalledSkill[] = []
  const taken = new Set<string>()
  for (const group of groups) {
    for (const skill of group) {
      if (taken.has(skill.name)) {
        out.push({ ...skill, effective: false })
      } else {
        taken.add(skill.name)
        out.push(skill)
      }
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}
