/**
 * 技能广场页：这个部署装了的全部技能，只读展示。
 *
 * 布局向看板看齐：三个来源（DSH 目录 / 共享目录 / 出厂自带）各占一列，
 * 列独立滚动。一个技能是一张**紧凑卡**——字母徽、名字、一行描述；详情
 * （完整描述、何时用、文件位置、生效状态）收进点开的弹窗里，与「创建
 * 小队」同一个弹窗形态。
 *
 * 纯展示组件——数据与拉取时机都由 BoardPanel 持有，这里只管把清单画出来。
 */

import { createElement, useEffect, useState } from 'react'
import type { SkillsView } from '../board-client.ts'
import type { InstalledSkill, SkillSource } from '../../domain/skills.ts'
import { SKILL_SOURCES, SKILL_SOURCE_LABELS } from '../../domain/skills.ts'
import { avatarChar, memberHue } from './MemberEditor.tsx'

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
  dsh: '~/.dsh/skills',
  agents: '~/.agents/skills',
  bundled: '随 DSH 出厂自带',
}

/** 技能详情弹窗的 props。 */
export interface SkillDetailDialogProps {
  readonly skill: InstalledSkill
  /** 盖住它的那份同名技能（仅当这份被盖住时存在），用于说明实际生效的是谁。 */
  readonly overriddenBy?: InstalledSkill
  readonly onClose: () => void
}

/** 徽章：仅手动调用 / 被同名盖住。卡片与弹窗共用。 */
function skillChips(skill: InstalledSkill): ReturnType<typeof createElement>[] {
  return [
    ...(skill.userOnly
      ? [createElement('span', { key: 'uo', 'data-vela-chip': '', title: '模型看不到它，只能在输入框里手动 / 调用' }, '仅手动调用')]
      : []),
    ...(!skill.effective
      ? [createElement('span', { key: 'sh', 'data-vela-chip': '', 'data-tone': 'medium' }, '被同名盖住')]
      : []),
  ]
}

/** 技能详情弹窗：点开一张技能卡后的完整信息。 */
export function SkillDetailDialog(props: SkillDetailDialogProps): ReturnType<typeof createElement> {
  const { skill, onClose } = props

  // Esc 关弹窗。捕获阶段拦截并阻止传播：BoardPanel 在 window 的冒泡阶段挂了
  // 全局「Esc 关面板」，不拦下的话按一下会连面板一起关（与创建小队弹窗同款处理）。
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // onClose 只调 setState，setter 是稳定的，所以空依赖安全。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return createElement(
    'div',
    { 'data-vela-modal-backdrop': '', onClick: onClose },
    createElement(
      'div',
      {
        'data-vela-modal': '',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': `技能 ${skill.name}`,
        // 点弹窗内部不穿透到遮罩。
        onClick: (event: { stopPropagation(): void }) => event.stopPropagation(),
      },
      createElement(
        'header',
        { 'data-vela-modal-head': '' },
        createElement('span', { 'data-vela-skill-dialog-title': '' },
          createElement('code', null, `/${skill.name}`),
          ...skillChips(skill)),
        createElement('button', {
          type: 'button',
          'data-vela-icon-btn': '',
          'aria-label': '关闭',
          onClick: onClose,
        }, '✕'),
      ),
      createElement(
        'div',
        { 'data-vela-modal-body': '' },
        ...(skill.problem !== undefined
          ? [createElement('div', { key: 'prob', 'data-vela-skill-problem': '' }, `⚠ ${skill.problem}`)]
          : []),
        createElement('div', { 'data-vela-skill-field': '' },
          createElement('div', { 'data-vela-skill-field-label': '' }, '做什么的'),
          createElement('div', null,
            skill.description.length > 0 ? skill.description : '（没有描述）')),
        ...(skill.whenToUse === undefined
          ? []
          : [createElement('div', { key: 'when', 'data-vela-skill-field': '' },
            createElement('div', { 'data-vela-skill-field-label': '' }, '何时用'),
            createElement('div', null, skill.whenToUse))]),
        createElement('div', { 'data-vela-skill-field': '' },
          createElement('div', { 'data-vela-skill-field-label': '' }, '来源'),
          createElement('div', null, `${SKILL_SOURCE_LABELS[skill.source]}（${SOURCE_HINTS[skill.source]}）`)),
        createElement('div', { 'data-vela-skill-field': '' },
          createElement('div', { 'data-vela-skill-field-label': '' }, '文件位置'),
          createElement('div', { 'data-vela-skill-path': '' }, skill.sourcePath)),
        createElement('div', { 'data-vela-skill-field': '' },
          createElement('div', { 'data-vela-skill-field-label': '' }, '状态'),
          createElement('div', null,
            skill.effective
              ? '生效中：对话里输入 /' + skill.name + ' 就能用。'
              : `被同名盖住：实际生效的是${props.overriddenBy === undefined
                ? '优先级更高的目录里的那份'
                : `${SKILL_SOURCE_LABELS[props.overriddenBy.source]}里的那份（${props.overriddenBy.sourcePath}）`}。`)),
      ),
    ),
  )
}

/** 一个技能的紧凑卡：字母徽 + 名字 + 一行描述，点开看详情。 */
function skillCard(skill: InstalledSkill, onOpen: (skill: InstalledSkill) => void): ReturnType<typeof createElement> {
  return createElement(
    'div',
    {
      key: `${skill.source}:${skill.sourcePath}`,
      'data-vela-skill-row': '',
      'data-dim': String(!skill.effective),
      role: 'button',
      tabIndex: 0,
      'aria-label': `技能 ${skill.name}，点开看详情`,
      onClick: () => onOpen(skill),
      onKeyDown: (event: { key: string }) => {
        if (event.key === 'Enter' || event.key === ' ') onOpen(skill)
      },
    },
    createElement('span', {
      'data-vela-avatar': '',
      'data-hue': String(memberHue(skill.name)),
      'aria-hidden': 'true',
    }, avatarChar(skill.name)),
    createElement('div', { 'data-vela-skill-main': '' },
      createElement('div', { 'data-vela-skill-title': '' },
        createElement('code', null, `/${skill.name}`),
        ...skillChips(skill)),
      skill.problem !== undefined
        ? createElement('div', { 'data-vela-skill-problem': '' }, `⚠ ${skill.problem}`)
        : createElement('div', { 'data-vela-skill-desc': '' },
          skill.description.length > 0 ? skill.description : '（没有描述）')),
  )
}

/** 一个来源一列。 */
function skillColumn(
  source: SkillSource,
  skills: readonly InstalledSkill[],
  onOpen: (skill: InstalledSkill) => void,
): ReturnType<typeof createElement> {
  return createElement(
    'section',
    { key: source, 'data-vela-skill-col': source },
    createElement('header', { 'data-vela-skill-col-head': '' },
      createElement('h3', null, `${SKILL_SOURCE_LABELS[source]}（${skills.length}）`),
      createElement('div', { 'data-vela-skill-hint': '' }, SOURCE_HINTS[source])),
    createElement(
      'div',
      { 'data-vela-skill-col-body': '' },
      ...(skills.length === 0
        ? [createElement('div', { key: 'empty', 'data-vela-empty': '' }, '这个目录还没有技能')]
        : skills.map(skill => skillCard(skill, onOpen))),
    ),
  )
}

/** 技能广场页。 */
export function SkillsPage(props: SkillsPageProps): ReturnType<typeof createElement> {
  const { view, failed, loading, onRefresh } = props
  /** 当前打开详情的那个技能。 */
  const [selected, setSelected] = useState<InstalledSkill | undefined>(undefined)

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

  // 详情弹窗里「被同名盖住」的说明需要知道生效的是哪份：同名且生效的那一个。
  const winnerOf = selected === undefined
    ? undefined
    : view.skills.find(skill => skill.name === selected.name && skill.effective)

  return createElement(
    'div',
    { 'data-vela-skills': '' },
    head,
    createElement(
      'div',
      { 'data-vela-skill-cols': '' },
      ...SKILL_SOURCES.map(source =>
        skillColumn(source, view.skills.filter(skill => skill.source === source), setSelected)),
    ),
    createElement('div', { 'data-vela-skill-footer': '' },
      '列的是全局目录。工作区里 .dsh/skills 的项目级技能不在这里——它们只在那个工作区里生效，优先级也更高。'),
    ...(selected === undefined
      ? []
      : [createElement(SkillDetailDialog, {
        key: 'detail',
        skill: selected,
        ...(winnerOf === undefined || winnerOf === selected ? {} : { overriddenBy: winnerOf }),
        onClose: () => setSelected(undefined),
      })]),
  )
}
