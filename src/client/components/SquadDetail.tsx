/**
 * 小队详情页：点进一支小队后的界面。
 *
 * 参考 Multica 的详情页用 **tab 分区**——成员 / 职责说明 / 设置——不再把所有
 * 字段堆成一长条。这解决了之前「编辑器没有呼吸感」的核心问题：每个 tab 只放
 * 一类事。
 *
 * 层级仍然守住（ADR-0017）：权限档位在「设置」tab（队级），队员的能力白名单
 * 在「成员」tab（队员级），两个 tab 天然把它们隔开，不会让人以为能混着设。
 *
 * 编辑是草稿式的：所有改动先落在本地 draft，点「保存」才提交——不会每敲一个
 * 字就写盘。
 */

import { createElement, useState } from 'react'
import type { SquadShape } from '../board-client.ts'
import type { SquadMember } from '../../domain/squad.ts'
import { DEFAULT_MAX_PARALLEL_MEMBERS, leaderInstruction } from '../../domain/squad.ts'
import { MemberEditor } from './MemberEditor.tsx'

/** 「沿用全局默认」这个档位选项的哨兵值。\u0000 前缀让它不会撞任何真实档位名。 */
const INHERIT = '\u0000inherit'

/** 编辑中的草稿。与已保存的小队分开，避免每敲一个字就写盘。 */
interface Draft {
  title: string
  instruction: string
  members: SquadMember[]
  sandbox: string
  maxParallelMembers: number
}

function draftOf(squad: SquadShape): Draft {
  return {
    title: squad.title,
    instruction: squad.instruction,
    members: squad.members.map(member => ({ ...member })),
    sandbox: squad.sandbox ?? INHERIT,
    maxParallelMembers: squad.maxParallelMembers,
  }
}

function newMember(index: number): SquadMember {
  return {
    name: `member_${index + 1}`,
    instruction: '',
    abilities: ['read'],
    backend: 'spawn',
  }
}

/** 详情页的 tab。 */
type Tab = 'members' | 'instructions' | 'settings'

/** SquadDetail 的 props。 */
export interface SquadDetailProps {
  readonly squad: SquadShape
  readonly platform: string
  readonly sandboxPresets: readonly string[]
  readonly busy: boolean
  /** 返回列表（放弃未保存的改动）。 */
  readonly onBack: () => void
  readonly onSave: (id: string, payload: Record<string, unknown>) => void
  readonly onDelete: (id: string) => void
}

/** 小队详情页。 */
export function SquadDetail(props: SquadDetailProps): ReturnType<typeof createElement> {
  const { squad, platform, busy } = props
  const [draft, setDraft] = useState<Draft>(() => draftOf(squad))
  const [tab, setTab] = useState<Tab>('members')

  const patch = (change: Partial<Draft>): void => {
    setDraft(current => ({ ...current, ...change }))
  }

  const patchMember = (index: number, change: Partial<SquadMember>): void => {
    setDraft(current => ({
      ...current,
      members: current.members.map((member, at) => (at === index ? { ...member, ...change } : member)),
    }))
  }

  const save = (): void => {
    props.onSave(squad.id, {
      title: draft.title.trim(),
      instruction: draft.instruction,
      members: draft.members,
      maxParallelMembers: draft.maxParallelMembers,
      ...(draft.sandbox === INHERIT ? {} : { sandbox: draft.sandbox }),
    })
  }

  const tabs: readonly { key: Tab; label: string }[] = [
    { key: 'members', label: `成员 ${draft.members.length}` },
    { key: 'instructions', label: '职责说明' },
    { key: 'settings', label: '设置' },
  ]

  return createElement(
    'div',
    { 'data-vela-squad-detail': '' },
    // 顶部：返回 + 名字（可改）+ 删除
    createElement(
      'div',
      { 'data-vela-detail-head': '' },
      createElement('button', {
        type: 'button',
        'data-vela-back': '',
        onClick: props.onBack,
      }, '← 小队'),
      createElement('input', {
        'data-vela-detail-title': '',
        value: draft.title,
        'aria-label': '小队名字',
        onChange: (event: { target: { value: string } }) => patch({ title: event.target.value }),
      }),
      createElement('button', {
        type: 'button',
        'data-vela-icon-btn': '',
        'data-tone': 'danger',
        'aria-label': `删除小队 ${squad.title}`,
        title: '删除小队',
        onClick: () => props.onDelete(squad.id),
      }, '✕'),
    ),
    // tab 条
    createElement(
      'div',
      { 'data-vela-tabs': '', role: 'tablist' },
      ...tabs.map(item => createElement('button', {
        key: item.key,
        type: 'button',
        role: 'tab',
        'aria-selected': tab === item.key,
        'data-active': String(tab === item.key),
        onClick: () => setTab(item.key),
      }, item.label)),
    ),
    // tab 内容
    createElement(
      'div',
      { 'data-vela-detail-body': '' },

      // ---- 成员 ----
      ...(tab === 'members' ? [createElement(
        'div',
        { key: 'members' },
        createElement(
          'div',
          { 'data-vela-squad-head': '' },
          createElement('div', { 'data-vela-hint': '' },
            `该小队有 ${draft.members.length} 名队员。每个队员各自决定能用哪几类工具（这是队员级，跟「设置」里的队级档位不是一回事）。`),
          createElement('button', {
            type: 'button',
            onClick: () => patch({ members: [...draft.members, newMember(draft.members.length)] }),
          }, '+ 加一个队员'),
        ),
        ...(draft.members.length === 0
          ? [createElement('div', { key: 'none', 'data-vela-empty': '' },
            '还没有队员。点右上「+ 加一个队员」——先建一个光杆队长也是正当用法。')]
          : draft.members.map((member, index) => createElement(MemberEditor, {
            key: index,
            member,
            index,
            platform,
            onPatch: change => patchMember(index, change),
            onRemove: () => patch({ members: draft.members.filter((_, at) => at !== index) }),
          }))),
      )] : []),

      // ---- 职责说明 ----
      ...(tab === 'instructions' ? [createElement(
        'div',
        { key: 'instructions' },
        createElement('label', { 'data-vela-modal-field': '' }, '队长职责',
          createElement('textarea', {
            value: draft.instruction,
            rows: 6,
            placeholder: '写清这支队负责什么、怎么拆活、什么算做完。',
            onChange: (event: { target: { value: string } }) => patch({ instruction: event.target.value }),
          })),
        createElement(
          'details',
          { 'data-vela-roster-fold': '' },
          createElement('summary', null, `队员名册（${draft.members.length} 人）——队长实际会看到`),
          createElement('div', { 'data-vela-hint': '' },
            'Vela 会把这段名册自动追加到队长的职责说明后面。DSH 给每个队员生成的工具说明是同一句通用话术，不加名册队长分不出谁是谁。'),
          createElement('pre', { 'data-vela-roster': '' }, leaderInstruction({
            id: squad.id,
            title: draft.title,
            instruction: '',
            members: draft.members,
            maxParallelMembers: draft.maxParallelMembers,
          }, platform).trim() || '（还没有队员）'),
        ),
      )] : []),

      // ---- 设置 ----
      ...(tab === 'settings' ? [createElement(
        'div',
        { key: 'settings' },
        createElement('div', { 'data-vela-hint': '' },
          '权限档位对整个小队生效——队员继承它且不能超出（这是队级，不是某个队员的）。'),
        createElement(
          'div',
          { 'data-vela-field-row': '' },
          createElement('label', null, '权限档位',
            createElement(
              'select',
              {
                value: draft.sandbox,
                onChange: (event: { target: { value: string } }) => patch({ sandbox: event.target.value }),
              },
              createElement('option', { key: INHERIT, value: INHERIT }, '沿用全局默认'),
              ...props.sandboxPresets.map(name => createElement('option', { key: name, value: name }, name)),
            )),
          createElement('label', null, '同时最多几个队员在跑',
            createElement('input', {
              type: 'number',
              min: 1,
              value: String(draft.maxParallelMembers),
              onChange: (event: { target: { value: string } }) => {
                const parsed = Number.parseInt(event.target.value, 10)
                patch({ maxParallelMembers: Number.isInteger(parsed) && parsed >= 1 ? parsed : 1 })
              },
            })),
        ),
        createElement('div', { 'data-vela-hint': '' },
          '并发上限是硬拦截：领不到号牌的队员会排队等，不是靠劝队长自律。'),
      )] : []),
    ),
    // 底部：保存
    createElement(
      'div',
      { 'data-vela-detail-foot': '' },
      createElement('button', {
        type: 'button',
        'data-tone': 'primary',
        disabled: busy || draft.title.trim().length === 0,
        onClick: save,
      }, busy ? '保存中…' : '保存'),
      createElement('button', { type: 'button', disabled: busy, onClick: props.onBack }, '放弃改动'),
    ),
  )
}
