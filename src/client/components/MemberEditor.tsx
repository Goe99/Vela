/**
 * 单个队员的编辑卡片。
 *
 * 从 SquadPage 抽出来：它在「创建」与「详情」两处都要用，各自塞一份会分叉。
 * 紧凑的四行布局——名字行 / 职责 / 能力 chip / 白名单小字，不再每个字段独占一行。
 */

import { createElement } from 'react'
import type { Ability, MemberBackend, SquadMember } from '../../domain/squad.ts'
import { ABILITIES, ABILITY_LABELS, memberTools } from '../../domain/squad.ts'

/** MemberEditor 的 props。 */
export interface MemberEditorProps {
  readonly member: SquadMember
  /** 队员序号，仅用于 aria 标签。 */
  readonly index: number
  /** 部署平台，用于把「跑命令」展开成真实工具名。 */
  readonly platform: string
  /** 改这个队员的某些字段。 */
  readonly onPatch: (change: Partial<SquadMember>) => void
  readonly onRemove: () => void
}

/** 单个队员的编辑卡片。 */
export function MemberEditor(props: MemberEditorProps): ReturnType<typeof createElement> {
  const { member, onPatch, onRemove, platform } = props
  return createElement(
    'div',
    { 'data-vela-member': member.name },
    // 第一行：名字 + 后端 + 移除图标（右上角）。
    createElement(
      'div',
      { 'data-vela-member-head': '' },
      createElement('input', {
        'data-vela-member-name': '',
        value: member.name,
        'aria-label': '队员名字',
        title: '名字（队长眼里这个队员就叫这个）',
        onChange: (event: { target: { value: string } }) => onPatch({ name: event.target.value }),
      }),
      createElement(
        'select',
        {
          'data-vela-member-backend': '',
          value: member.backend,
          'aria-label': '执行后端',
          title: 'spawn 独立上下文最常用；fork 带上队长已完成的对话。Codex / Claude Code 下一期才支持。',
          onChange: (event: { target: { value: string } }) =>
            onPatch({ backend: event.target.value as MemberBackend }),
        },
        createElement('option', { value: 'spawn' }, 'spawn'),
        createElement('option', { value: 'fork' }, 'fork'),
        createElement('option', { value: 'codex', disabled: true }, 'Codex（下一期）'),
        createElement('option', { value: 'claude-code', disabled: true }, 'Claude Code（下一期）'),
      ),
      createElement('button', {
        type: 'button',
        'data-vela-icon-btn': '',
        'data-tone': 'danger',
        'aria-label': `移除队员 ${member.name}`,
        title: '移除这个队员',
        onClick: onRemove,
      }, '✕'),
    ),
    // 第二行：职责
    createElement('textarea', {
      'data-vela-member-instruction': '',
      value: member.instruction,
      rows: 2,
      placeholder: '这个队员负责什么。例如：只改前端，不碰后端接口。',
      'aria-label': '职责说明',
      onChange: (event: { target: { value: string } }) => onPatch({ instruction: event.target.value }),
    }),
    // 第三行：能力是可点的 chip
    createElement(
      'div',
      { 'data-vela-abilities': '' },
      ...ABILITIES.map((ability) => {
        const on = member.abilities.includes(ability)
        return createElement(
          'label',
          { key: ability, 'data-vela-ability': ability, 'data-on': String(on) },
          createElement('input', {
            type: 'checkbox',
            checked: on,
            'aria-label': ABILITY_LABELS[ability],
            onChange: () => {
              const next: Ability[] = on
                ? member.abilities.filter(item => item !== ability)
                : [...member.abilities, ability]
              onPatch({ abilities: next })
            },
          }),
          createElement('span', null, ABILITY_LABELS[ability]),
        )
      }),
    ),
    // 第四行：实际白名单（小字）
    createElement('div', { 'data-vela-member-tools': '' },
      `白名单：${memberTools(member, platform).join('、') || '（空——至少勾一项，否则这个队员没有任何工具）'}`),
  )
}
