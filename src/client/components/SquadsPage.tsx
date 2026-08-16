/**
 * 小队编辑器（票 07 / ADR-0016、ADR-0017）。
 *
 * 界面上有一条**必须守住的层级区分**：沙箱档位是**整支队**的一个选择，工具
 * 白名单是**每个队员**各自的选择（ADR-0017）。两者摆成同一排会误导 Operator
 * 以为可以给单个队员单独设档位——DSH 里没有那个接缝。
 */

import { createElement, useState } from 'react'
import type { BoardClient, SquadShape } from '../board-client.ts'
import type { Ability, MemberBackend, SquadMember } from '../../domain/squad.ts'
import {
  ABILITIES, ABILITY_LABELS, DEFAULT_MAX_PARALLEL_MEMBERS, leaderInstruction, memberTools,
} from '../../domain/squad.ts'

/** 小队页的 props。 */
export interface SquadsPageProps {
  readonly squads: readonly SquadShape[]
  /** 这个部署有没有可写的 preset 根；没有则整页只读并说明原因。 */
  readonly canManage: boolean
  readonly sandboxPresets: readonly string[]
  /** 部署平台，用于把「跑命令」展开成 `pwsh` 或 `bash`。 */
  readonly platform: string
  readonly client: BoardClient
  onChanged(): void | Promise<void>
}

/** 编辑中的草稿。与已保存的小队分开，避免每敲一个字就写盘。 */
interface Draft {
  /** 已存在的小队 id；新建时 undefined。 */
  readonly id?: string
  title: string
  instruction: string
  members: SquadMember[]
  sandbox: string
  maxParallelMembers: number
}

/** 「沿用全局默认」这个档位选项的哨兵值。 */
const INHERIT = '\u0000inherit'

function emptyDraft(): Draft {
  return {
    title: '',
    instruction: '',
    members: [],
    sandbox: INHERIT,
    maxParallelMembers: DEFAULT_MAX_PARALLEL_MEMBERS,
  }
}

function draftOf(squad: SquadShape): Draft {
  return {
    id: squad.id,
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

/** 小队编辑页。 */
export function SquadsPage(props: SquadsPageProps): ReturnType<typeof createElement> {
  const { client, onChanged } = props
  const [draft, setDraft] = useState<Draft | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  const act = async (operation: () => Promise<{ ok: boolean; message?: string }>): Promise<boolean> => {
    if (busy) return false
    setBusy(true)
    setError(undefined)
    try {
      const result = await operation()
      if (!result.ok) {
        setError(result.message ?? '操作失败')
        return false
      }
      await onChanged()
      return true
    } finally {
      setBusy(false)
    }
  }

  const save = async (): Promise<void> => {
    if (draft === undefined) return
    const payload = {
      title: draft.title,
      instruction: draft.instruction,
      members: draft.members,
      maxParallelMembers: draft.maxParallelMembers,
      ...(draft.sandbox === INHERIT ? {} : { sandbox: draft.sandbox }),
    }
    const ok = await act(() => (draft.id === undefined
      ? client.createSquad(payload)
      : client.updateSquad(draft.id, payload)))
    if (ok) setDraft(undefined)
  }

  const patch = (change: Partial<Draft>): void => {
    setDraft(current => (current === undefined ? current : { ...current, ...change }))
  }

  const patchMember = (index: number, change: Partial<SquadMember>): void => {
    setDraft((current) => {
      if (current === undefined) return current
      const members = current.members.map((member, at) => (at === index ? { ...member, ...change } : member))
      return { ...current, members }
    })
  }

  if (!props.canManage) {
    return createElement(
      'div',
      { 'data-vela-squads': '' },
      createElement('div', { 'data-vela-empty': '' },
        '这个部署没有可写的 agent 配置目录，所以建不了小队。给 Vela 配上 squadRoot 就能用。'),
    )
  }

  return createElement(
    'div',
    { 'data-vela-squads': '' },
    ...(error === undefined ? [] : [createElement('div', { key: 'err', 'data-vela-error': '' }, error)]),
    // ---- 列表 ----
    ...(draft !== undefined ? [] : [createElement(
      'div',
      { key: 'list', 'data-vela-squad-list': '' },
      createElement(
        'div',
        { 'data-vela-squad-head': '' },
        createElement('h2', null, '小队'),
        createElement('button', {
          type: 'button',
          'data-tone': 'primary',
          disabled: busy,
          onClick: () => setDraft(emptyDraft()),
        }, '新建小队'),
      ),
      ...(props.squads.length === 0
        ? [createElement('div', { key: 'empty', 'data-vela-empty': '' },
          '还没有小队。一支小队 = 一个队长 + 若干队员，队长自己决定把活派给谁。')]
        : props.squads.map(squad => createElement(
          'div',
          { key: squad.id, 'data-vela-squad-row': squad.id },
          createElement('div', { 'data-vela-squad-title': '' }, squad.title),
          createElement(
            'div',
            { 'data-vela-squad-meta': '' },
            createElement('span', { 'data-vela-chip': '' }, `${squad.members.length} 名队员`),
            createElement('span', { 'data-vela-chip': '' },
              `同时最多 ${squad.maxParallelMembers} 个在跑`),
            createElement('span', { 'data-vela-chip': '' },
              squad.sandbox === undefined ? '档位沿用默认' : squad.sandbox),
          ),
          createElement(
            'div',
            { 'data-vela-actions': '' },
            createElement('button', {
              type: 'button', disabled: busy, onClick: () => setDraft(draftOf(squad)),
            }, '编辑'),
            createElement('button', {
              type: 'button',
              disabled: busy,
              'data-tone': 'danger',
              'aria-label': `删除小队 ${squad.title}`,
              onClick: () => void act(() => client.deleteSquad(squad.id)),
            }, '删除'),
          ),
        ))),
    )]),
    // ---- 编辑器 ----
    ...(draft === undefined ? [] : [createElement(
      'div',
      { key: 'editor', 'data-vela-squad-editor': '' },
      createElement('h2', null, draft.id === undefined ? '新建小队' : `编辑：${draft.title}`),

      createElement('label', null, '小队名字',
        createElement('input', {
          value: draft.title,
          placeholder: '例如：后端小队',
          onChange: (event: { target: { value: string } }) => patch({ title: event.target.value }),
        })),

      // ---- 队长 ----
      createElement('div', { 'data-vela-squad-section': 'leader' },
        createElement('h3', null, '队长'),
        createElement('label', null, '职责说明',
          createElement('textarea', {
            value: draft.instruction,
            rows: 5,
            placeholder: '写清这支队负责什么、怎么拆活、什么算做完。',
            onChange: (event: { target: { value: string } }) => patch({ instruction: event.target.value }),
          })),
        // 队员名册是自动追加的，这里只读展示——Operator 要看得到队长实际收到什么。
        createElement('div', { 'data-vela-hint': '' },
          'Vela 会把下面这段队员名册自动追加到队长的职责说明后面（DSH 给每个队员生成的工具说明是同一句通用话术，不加名册队长分不出谁是谁）：'),
        createElement('pre', { 'data-vela-roster': '' }, leaderInstruction({
          id: draft.id ?? 'vela-preview',
          title: draft.title,
          instruction: '',
          members: draft.members,
          maxParallelMembers: draft.maxParallelMembers,
        }, props.platform).trim() || '（还没有队员）'),
      ),

      // ---- 整支队的设置：与队员区域明确分开（ADR-0017）----
      createElement('div', { 'data-vela-squad-section': 'squad' },
        createElement('h3', null, '整支队的设置'),
        createElement('label', null, '权限档位（整支队一档，队员继承且不能超出）',
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
        createElement('div', { 'data-vela-hint': '' },
          '这是硬拦截：领不到号牌的队员会排队等，不是靠劝队长自律。'),
      ),

      // ---- 队员 ----
      createElement('div', { 'data-vela-squad-section': 'members' },
        createElement(
          'div',
          { 'data-vela-squad-head': '' },
          createElement('h3', null, `队员（${draft.members.length}）`),
          createElement('button', {
            type: 'button',
            onClick: () => patch({ members: [...draft.members, newMember(draft.members.length)] }),
          }, '加一个队员'),
        ),
        ...(draft.members.length === 0
          ? [createElement('div', { key: 'none', 'data-vela-hint': '' },
            '没有队员也能保存——先建一个光杆队长是正当用法。')]
          : draft.members.map((member, index) => createElement(
            'div',
            { key: index, 'data-vela-member': member.name },
            createElement('label', null, '名字（队长眼里这个队员就叫这个）',
              createElement('input', {
                value: member.name,
                onChange: (event: { target: { value: string } }) =>
                  patchMember(index, { name: event.target.value }),
              })),
            createElement('label', null, '职责说明',
              createElement('textarea', {
                value: member.instruction,
                rows: 2,
                placeholder: '例如：只改前端，不碰后端接口。',
                onChange: (event: { target: { value: string } }) =>
                  patchMember(index, { instruction: event.target.value }),
              })),
            createElement(
              'div',
              { 'data-vela-abilities': '' },
              createElement('span', { 'data-vela-hint': '' }, '能用哪几类工具'),
              ...ABILITIES.map(ability => createElement(
                'label',
                { key: ability, 'data-vela-ability': ability },
                createElement('input', {
                  type: 'checkbox',
                  checked: member.abilities.includes(ability),
                  onChange: () => {
                    const has = member.abilities.includes(ability)
                    const next: Ability[] = has
                      ? member.abilities.filter(item => item !== ability)
                      : [...member.abilities, ability]
                    patchMember(index, { abilities: next })
                  },
                }),
                ABILITY_LABELS[ability],
              )),
            ),
            // 把展开后的真实工具名摊出来：Operator 勾的是粗粒度，真正生效的是这些。
            createElement('div', { 'data-vela-hint': '' },
              `实际白名单：${memberTools(member, props.platform).join('、') || '（空——至少勾一项，否则这个队员没有任何工具）'}`),
            createElement('label', null, '执行后端',
              createElement(
                'select',
                {
                  value: member.backend,
                  onChange: (event: { target: { value: string } }) =>
                    patchMember(index, { backend: event.target.value as MemberBackend }),
                },
                createElement('option', { value: 'spawn' }, 'spawn（独立上下文，最常用）'),
                createElement('option', { value: 'fork' }, 'fork（带上队长已完成的对话）'),
                // 外部产品后端本期不做：它们不支持自己的职责说明与白名单（ADR-0017）。
                createElement('option', { value: 'codex', disabled: true }, 'Codex（下一期：不支持职责说明与限权）'),
                createElement('option', { value: 'claude-code', disabled: true }, 'Claude Code（下一期：同上）'),
              )),
            createElement('button', {
              type: 'button',
              'data-tone': 'danger',
              'aria-label': `移除队员 ${member.name}`,
              onClick: () => patch({ members: draft.members.filter((_, at) => at !== index) }),
            }, '移除这个队员'),
          ))),
      ),

      createElement(
        'div',
        { 'data-vela-actions': '' },
        createElement('button', {
          type: 'button', 'data-tone': 'primary', disabled: busy, onClick: () => void save(),
        }, '保存'),
        createElement('button', {
          type: 'button', disabled: busy, onClick: () => { setDraft(undefined); setError(undefined) },
        }, '取消'),
      ),
    )]),
  )
}
