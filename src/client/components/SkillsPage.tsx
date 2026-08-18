/**
 * 技能广场页：这个部署装了的全部技能，只读展示。
 *
 * 纯展示组件——数据与拉取时机都由 BoardPanel 持有（它在导航切进来时拉取，
 * 并拿着「拉取失败」与「还没装」的区别）。这里只管把清单画出来。
 *
 * 布局与小队页同款：一个页头（标题 + 计数 + 刷新），下面按来源分组，每个
 * 技能一行卡片。按来源分组而不是平铺：同名技能被谁盖住这件事，只有摆回
 * 各自来源里才看得懂。
 */

import { createElement } from 'react'
import type { SkillsView } from '../board-client.ts'
import type { InstalledSkill, SkillSource } from '../../domain/skills.ts'
import { SKILL_SOURCES, SKILL_SOURCE_LABELS } from '../../domain/skills.ts'

/** 技能广场的 props。 */
export interface SkillsPageProps {
  /** undefined = 拉取失败（failed 为真）或还没拉过。 */
  readonly view?: SkillsView
  /** 上一次拉取失败过：显示成「拉取失败 + 重试」，而不是空列表。 */
  readonly failed: boolean
  /** 正在拉取中。 */
  readonly loading: boolean
  onRefresh(): void
}

/** 每个来源目录的一句说明（路径给人看，方便去目录里加技能）。 */
const SOURCE_HINTS: Readonly<Record<SkillSource, string>> = {
  dsh: 'DSH 目录下的技能（~/.dsh/skills）',
  agents: '共享目录下的技能（~/.agents/skills）',
  bundled: '随 DSH 出厂自带的技能',
}

/** 一个技能的一行。 */
function skillRow(skill: InstalledSkill): ReturnType<typeof createElement> {
  return createElement(
    'div',
    { key: `${skill.source}:${skill.sourcePath}`, 'data-vela-skill-row': '', 'data-dim': String(!skill.effective) },
    createElement('div', { 'data-vela-skill-main': '' },
      createElement('div', { 'data-vela-skill-title': '' },
        createElement('code', null, `/${skill.name}`),
        // 「仅限手动」与「被盖住」是这个技能能不能被用起来的关键事实，
        // 放在名字旁边而不是收进详情。
        ...(skill.userOnly
          ? [createElement('span', { key: 'uo', 'data-vela-chip': '', title: '模型看不到它，只能在输入框里手动 / 调用' }, '仅手动调用')]
          : []),
        ...(!skill.effective
          ? [createElement('span', { key: 'sh', 'data-vela-chip': '', 'data-tone': 'medium', title: '更高优先级的目录里有同名技能，实际生效的是那份' }, '被同名盖住')]
          : [])),
      ...(skill.problem !== undefined
        ? [createElement('div', { key: 'prob', 'data-vela-skill-problem': '' }, `⚠ ${skill.problem}`)]
        : skill.description.length > 0
          ? [createElement('div', { key: 'desc', 'data-vela-skill-desc': '' }, skill.description)]
          : [createElement('div', { key: 'desc', 'data-vela-skill-desc': '', 'data-vela-muted': '' }, '（没有描述）')]),
      ...(skill.whenToUse === undefined
        ? []
        : [createElement('div', { key: 'when', 'data-vela-skill-when': '' }, `何时用：${skill.whenToUse}`)]),
      createElement('div', { 'data-vela-skill-path': '', title: skill.sourcePath }, skill.sourcePath)),
  )
}

/** 技能广场页。 */
export function SkillsPage(props: SkillsPageProps): ReturnType<typeof createElement> {
  const { view, failed, loading, onRefresh } = props

  const head = createElement(
    'div',
    { 'data-vela-skill-head': '' },
    createElement('h2', null, '技能'),
    ...(view === undefined ? [] : [createElement('span', { key: 'n', 'data-vela-chip': '' }, `${view.skills.length} 个`)]),
    createElement('button', {
      type: 'button',
      disabled: loading,
      onClick: onRefresh,
      'aria-label': '刷新技能列表',
    }, loading ? '在扫…' : '刷新'),
  )

  // 拉取失败：与「一个也没装」分清——后者该看到安装指引，前者该看到重试。
  if (failed && view === undefined) {
    return createElement(
      'div',
      { 'data-vela-skills': '' },
      head,
      createElement('div', { 'data-vela-error': '' }, '技能列表拉取失败。点「刷新」重试。'),
    )
  }

  if (view === undefined) {
    return createElement(
      'div',
      { 'data-vela-skills': '' },
      head,
      createElement('div', { 'data-vela-empty': '' }, '正在扫技能目录…'),
    )
  }

  if (!view.available) {
    return createElement(
      'div',
      { 'data-vela-skills': '' },
      head,
      createElement('div', { 'data-vela-empty': '' }, '这个部署没有开技能页。'),
    )
  }

  if (view.skills.length === 0) {
    return createElement(
      'div',
      { 'data-vela-skills': '' },
      head,
      createElement('div', { 'data-vela-empty': '' },
        '还没有装技能。技能是一个含 SKILL.md 的目录，放进 ~/.dsh/skills 或 ~/.agents/skills 就算装好，回到这里点「刷新」即见。'),
    )
  }

  return createElement(
    'div',
    { 'data-vela-skills': '' },
    head,
    ...SKILL_SOURCES.map((source) => {
      const group = view.skills.filter(skill => skill.source === source)
      if (group.length === 0) return null
      return createElement(
        'section',
        { key: source, 'data-vela-skill-group': source },
        createElement('h3', null, `${SKILL_SOURCE_LABELS[source]}（${group.length}）`),
        createElement('div', { 'data-vela-skill-hint': '' }, SOURCE_HINTS[source]),
        ...group.map(skillRow),
      )
    }),
    createElement('div', { 'data-vela-skill-footer': '' },
      '列的是全局目录。工作区里 .dsh/skills 的项目级技能不在这里——它们只在那个工作区里生效，优先级也更高。'),
  )
}
