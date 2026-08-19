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
import type { ModelOption } from '../../domain/models.ts'
import { DEFAULT_MAX_PARALLEL_MEMBERS, leaderInstruction } from '../../domain/squad.ts'
import { AddMemberDialog } from './AddMemberDialog.tsx'
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

/** 详情页的 tab。 */
type Tab = 'members' | 'instructions' | 'settings'

/** SquadDetail 的 props。 */
export interface SquadDetailProps {
  readonly squad: SquadShape
  readonly platform: string
  /** 这个部署接入的模型清单，供队员的模型下拉；空表 = 退化为手输。 */
  readonly modelCatalog: readonly ModelOption[]
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
  /** 「+ 加队员」的弹窗是否打开。 */
  const [dialogOpen, setDialogOpen] = useState(false)

  const patch = (change: Partial<Draft>): void => {
    setDraft(current => ({ ...current, ...change }))
  }

  /** 弹窗里点中一张卡：队员进草稿，然后关窗——任务完成了就别再占着地方。 */
  const addMember = (member: SquadMember): void => {
    patch({ members: [...draft.members, member] })
    setDialogOpen(false)
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
    // 计数把队长算进去：在 Operator 眼里队长就是成员之一（Multica 也这么数）。
    { key: 'members', label: `成员 ${draft.members.length + 1}` },
    { key: 'instructions', label: '职责说明' },
    { key: 'settings', label: '设置' },
  ]

  /** 队长固定拿着的能力。只读展示——它们来自基准 preset，不在小队层面改。 */
  const LEADER_ABILITIES = ['读文件', '改文件', '跑命令', '联网', '委派队员'] as const

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
            '队长接收派给这支队的第一手任务，再按职责分给队员。工具是队员级的——每个队员只能用自己那几类（跟「设置」里的队级档位不是一回事）。'),
          createElement('div', { 'data-vela-squad-add': '' },
            createElement('button', {
              type: 'button',
              'data-tone': 'primary',
              onClick: () => setDialogOpen(true),
            }, '+ 加队员'),
          ),
        ),
        // 队长卡：永远在成员列表最前面。它不是 members 数组里的一条——队长就是
        // 基准 preset 扮演的角色，它的配置就是那段职责说明（draft.instruction）。
        // 但界面把它摆出来：小队里"有谁"这件事，队长不该隐身。
        createElement(
          'div',
          { 'data-vela-leader': '' },
          createElement(
            'div',
            { 'data-vela-member-head': '' },
            createElement('span', { 'data-vela-avatar': '', 'data-hue': 'leader', 'aria-hidden': 'true' }, '队'),
            createElement('span', { 'data-vela-leader-name': '' }, '队长'),
            createElement('span', { 'data-vela-leader-badge': '' }, 'LEADER'),
          ),
          createElement('textarea', {
            'data-vela-member-instruction': '',
            value: draft.instruction,
            rows: 2,
            placeholder: '队长的常驻职责：这支队负责什么、怎么拆活、什么算做完。',
            'aria-label': '队长职责',
            onChange: (event: { target: { value: string } }) => patch({ instruction: event.target.value }),
          }),
          createElement(
            'div',
            { 'data-vela-abilities': '', 'data-readonly': '' },
            ...LEADER_ABILITIES.map(label =>
              createElement('span', { key: label, 'data-vela-ability': label, 'data-on': 'true' },
                createElement('span', null, label))),
          ),
          createElement('div', { 'data-vela-member-tools': '' },
            '队长拿全部能力——安全边界设在队员身上：每个队员只能用自己白名单里的工具。'),
        ),
        ...(draft.members.length === 0
          ? [createElement('div', { key: 'none', 'data-vela-empty': '' },
            '还没有队员。右上「+ 加队员」可以从角色模板一键起一个——先建一个光杆队长也是正当用法。')]
          : [createElement(
            'div',
            { key: 'grid', 'data-vela-member-grid': '' },
            // 队员卡铺成网格，用满整个宽度——一张卡一列是窄屏时代的遗留，
            // 宽屏下右侧大片空白，而队员卡的内容（四行）在 400px 格里正好。
            ...draft.members.map((member, index) => createElement(MemberEditor, {
              key: index,
              member,
              index,
              platform,
              modelCatalog: props.modelCatalog,
              onPatch: change => patchMember(index, change),
              onRemove: () => patch({ members: draft.members.filter((_, at) => at !== index) }),
            })),
          )]),
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
    // 加队员弹窗：点卡即加，Esc/遮罩/X/取消只关窗不加人。
    ...(dialogOpen ? [createElement(AddMemberDialog, {
      key: 'add-member',
      existingNames: draft.members.map(m => m.name),
      memberCount: draft.members.length,
      onPick: addMember,
      onClose: () => setDialogOpen(false),
    })] : []),
  )
}
