/**
 * 小队页（重构后）。
 *
 * 三个状态，而不是过去那种「列表和一长条编辑器挤在一个页面」：
 * - **列表**：干净的一行一支，点进去看详情。删除是右上角的小图标。
 * - **创建**：弹一个居中的对话框（CreateSquadDialog），只建骨架。
 * - **详情**：点进一支后整页给它，用 tab 分区（SquadDetail）。
 *
 * 编辑逻辑（草稿、保存）沉在 SquadDetail 里；这里只做视图切换与提交。
 */

import { createElement, useState } from 'react'
import type { BoardClient, SquadShape } from '../board-client.ts'
import type { ModelOption } from '../../domain/models.ts'
import { DEFAULT_MAX_PARALLEL_MEMBERS } from '../../domain/squad.ts'
import { CreateSquadDialog } from './CreateSquadDialog.tsx'
import { avatarChar, memberHue } from './MemberEditor.tsx'
import { SquadDetail } from './SquadDetail.tsx'

/** 小队页的 props。 */
export interface SquadsPageProps {
  readonly squads: readonly SquadShape[]
  /** 这个部署有没有可写的 preset 根；没有则整页只读并说明原因。 */
  readonly canManage: boolean
  readonly sandboxPresets: readonly string[]
  /** 部署平台，用于把「跑命令」展开成 `pwsh` 或 `bash`。 */
  readonly platform: string
  /** 这个部署接入的模型清单，供队员的模型下拉；空表 = 退化为手输。 */
  readonly modelCatalog: readonly ModelOption[]
  readonly client: BoardClient
  onChanged(): void | Promise<void>
}

/** 当前在列表还是某一支的详情。 */
type View = { readonly kind: 'list' } | { readonly kind: 'detail'; readonly id: string }

/** 小队页。 */
export function SquadsPage(props: SquadsPageProps): ReturnType<typeof createElement> {
  const { client, onChanged } = props
  const [view, setView] = useState<View>({ kind: 'list' })
  const [createOpen, setCreateOpen] = useState(false)
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

  if (!props.canManage) {
    return createElement(
      'div',
      { 'data-vela-squads': '' },
      createElement('div', { 'data-vela-empty': '' },
        '这个部署没有可写的 agent 配置目录，所以建不了小队。给 Vela 配上 squadRoot 就能用。'),
    )
  }

  // ---- 详情视图 ----
  if (view.kind === 'detail') {
    const squad = props.squads.find(item => item.id === view.id)
    if (squad === undefined) {
      // 小队可能刚被删掉，回列表。
      setView({ kind: 'list' })
      return createElement('div', { 'data-vela-squads': '' })
    }
    return createElement(
      'div',
      { 'data-vela-squads': '' },
      createElement(SquadDetail, {
        // key 让小队切换时组件重建，draft 跟着重置成新那支的已保存状态。
        key: squad.id,
        squad,
        platform: props.platform,
        modelCatalog: props.modelCatalog,
        sandboxPresets: props.sandboxPresets,
        busy,
        onBack: () => setView({ kind: 'list' }),
        onSave: (id, payload) => {
          void act(() => client.updateSquad(id, payload)).then((ok) => {
            if (ok) setView({ kind: 'list' })
          })
        },
        onDelete: (id) => {
          void act(() => client.deleteSquad(id)).then((ok) => {
            if (ok) setView({ kind: 'list' })
          })
        },
      }),
    )
  }

  // ---- 列表视图 ----
  return createElement(
    'div',
    { 'data-vela-squads': '' },
    ...(error === undefined ? [] : [createElement('div', { key: 'err', 'data-vela-error': '' }, error)]),
    createElement(
      'div',
      { 'data-vela-squad-head': '' },
      createElement('h2', null, '小队'),
      createElement('button', {
        type: 'button',
        'data-tone': 'primary',
        disabled: busy,
        onClick: () => setCreateOpen(true),
      }, '新建小队'),
    ),
    ...(props.squads.length === 0
      ? [createElement('div', { key: 'empty', 'data-vela-empty': '' },
        '还没有小队。一支小队 = 一个队长 + 若干队员，队长自己决定把活派给谁。')]
      : props.squads.map(squad => createElement(
        'div',
        {
          key: squad.id,
          'data-vela-squad-row': squad.id,
          role: 'button',
          tabIndex: 0,
          onClick: () => setView({ kind: 'detail', id: squad.id }),
          onKeyDown: (event: { key: string }) => {
            if (event.key === 'Enter' || event.key === ' ') setView({ kind: 'detail', id: squad.id })
          },
        },
        createElement('span', {
          'data-vela-avatar': '',
          'data-hue': String(memberHue(squad.title)),
          'aria-hidden': 'true',
        }, avatarChar(squad.title)),
        createElement('div', { 'data-vela-squad-main': '' },
          createElement('div', { 'data-vela-squad-title': '' }, squad.title),
          createElement(
            'div',
            { 'data-vela-squad-meta': '' },
            // 计数把队长算进去，与详情页的「成员」tab 口径一致。
            createElement('span', { 'data-vela-chip': '' }, `${squad.members.length + 1} 名成员`),
            createElement('span', { 'data-vela-chip': '' }, `同时最多 ${squad.maxParallelMembers} 个在跑`),
            createElement('span', { 'data-vela-chip': '' },
              squad.sandbox === undefined ? '档位沿用默认' : squad.sandbox),
          ),
        ),
        // 删除收成右上角的小图标；点它不进详情。
        createElement('button', {
          type: 'button',
          disabled: busy,
          'data-vela-icon-btn': '',
          'data-tone': 'danger',
          'aria-label': `删除小队 ${squad.title}`,
          title: '删除小队',
          onClick: (event: { stopPropagation(): void }) => {
            event.stopPropagation()
            void act(() => client.deleteSquad(squad.id))
          },
        }, '✕'),
      ))),

    // 创建对话框
    ...(createOpen ? [createElement(CreateSquadDialog, {
      key: 'create',
      busy,
      onClose: () => setCreateOpen(false),
      onCreate: (input) => {
        void act(() => client.createSquad({
          title: input.title,
          instruction: input.instruction,
          members: [],
          maxParallelMembers: DEFAULT_MAX_PARALLEL_MEMBERS,
        })).then((ok) => {
          if (ok) setCreateOpen(false)
        })
      },
    })] : []),
  )
}
