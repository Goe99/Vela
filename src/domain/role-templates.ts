/**
 * 队员的角色模板。
 *
 * 参考 dsh-agent-teams 的预定义角色（engineer / researcher / reviewer …），
 * 但翻译成 Vela 的语言：模板的产出是一份 SquadMember 草稿——默认名字、
 * 一段能直接用的职责说明、一套能力勾选。模板只是**起点**：加进来之后
 * 每个字段都能改，模板本身不进运行时。
 *
 * 为什么需要模板：从零写一个队员要想三件事——叫什么、负责什么、给哪些
 * 能力——其中后两件大多数人每次写的都差不多。模板把「想」变成「挑」。
 */

import type { Ability, MemberBackend, SquadMember } from './squad.ts'

/** 一个角色模板。 */
export interface RoleTemplate {
  /** 模板 id，稳定。 */
  readonly id: string
  /** 展示名。 */
  readonly label: string
  /** 加进来时的默认队员名（队长眼里它叫这个）。 */
  readonly name: string
  /** 给人看的一句话摘要，显示在模板卡上。 */
  readonly blurb: string
  /** 预填的职责说明。 */
  readonly instruction: string
  /** 预勾选的能力。 */
  readonly abilities: readonly Ability[]
  /** 预选的执行后端；缺省 spawn。 */
  readonly backend?: MemberBackend
}

/** 全部模板，按展示顺序。 */
export const ROLE_TEMPLATES: readonly RoleTemplate[] = [
  {
    id: 'engineer',
    label: '工程师',
    name: 'engineer',
    blurb: '写实现、修 bug，能跑命令验证',
    instruction: '你写实现代码。改动最小、贴合既有风格，完成后跑一遍相关测试。',
    abilities: ['read', 'edit', 'shell'],
  },
  {
    id: 'researcher',
    label: '研究员',
    name: 'researcher',
    blurb: '查资料、读代码、给结论，不动文件',
    instruction: '你只读不写：查资料、读代码、回答问题。结论要给出处（文件、行、链接）。',
    abilities: ['read', 'web'],
  },
  {
    id: 'reviewer',
    label: '审查员',
    name: 'reviewer',
    blurb: '只读审查：找逻辑错误与边界漏洞',
    instruction: '你只读不写。审查改动：找逻辑错误、漏掉的边界、与既有风格不一致的地方，按严重程度列出。',
    abilities: ['read'],
  },
  {
    id: 'designer',
    label: '界面设计师',
    name: 'designer',
    blurb: '界面与样式，贴合既有视觉体系',
    instruction: '你负责界面与样式。保持与既有视觉体系一致：色板变量、间距节奏、明暗两套主题都要成立。',
    abilities: ['read', 'edit'],
  },
  {
    id: 'docs',
    label: '文档员',
    name: 'docs',
    blurb: '只写文档与注释，不碰实现',
    instruction: '你只改文档与注释，不碰实现。写给人看：说清是什么、怎么用、为什么这么做。',
    abilities: ['read', 'edit'],
  },
  {
    id: 'analyst',
    label: '数据分析师',
    name: 'analyst',
    blurb: '跑脚本、读数据、给带样本数的结论',
    instruction: '你跑脚本、读数据、给数字结论。结论必须带样本数，不许只报比例不报底数。',
    abilities: ['read', 'shell'],
  },
]

/**
 * 把一个模板实例化成队员草稿。名字撞上已有队员时自动加序号
 * （engineer → engineer_2），因为队员名是工具名，撞了整支队起不来。
 */
export function instantiateTemplate(template: RoleTemplate, existingNames: readonly string[]): SquadMember {
  const taken = new Set(existingNames)
  let name = template.name
  for (let n = 2; taken.has(name); n += 1) name = `${template.name}_${n}`
  return {
    name,
    instruction: template.instruction,
    abilities: template.abilities,
    backend: template.backend ?? 'spawn',
  }
}
