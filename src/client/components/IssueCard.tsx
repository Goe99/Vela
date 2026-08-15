/**
 * 一张 Issue 卡片。它是全部按 Issue 的操作的落点：派活、取消、Gate 的接受与
 * 退回、重新派活、编辑、删除，以及 token 用量与失败原因的展示。
 *
 * 按钮集合按 Lane 变化——这不是装饰，而是状态机的直接投影：Running 期间不能
 * 编辑或删除（会让活 Run 成为孤儿），Review 才有 Gate，Done 不再派活入口之外
 * 的操作。
 */

import { createElement, useState } from 'react'
import type { Issue, Lane, TokenUsage } from '../../domain/types.ts'
import { activeRun } from '../../domain/board.ts'
import { sumUsage, totalTokens } from '../../domain/usage.ts'
import type { BoardClient } from '../board-client.ts'
import { EditIssueForm } from './EditIssueForm.tsx'

/** 卡片的 props。 */
export interface IssueCardProps {
  readonly issue: Issue
  readonly showWorkspace: boolean
  readonly sandboxPresets: readonly string[]
  readonly canDispatch: boolean
  /** 在途 Run 的实时用量；不落盘，只用于展示。 */
  readonly liveUsage: TokenUsage | undefined
  readonly client: BoardClient
  readonly isDragging: boolean
  readonly canMoveUp: boolean
  readonly canMoveDown: boolean
  /** 跳到一次执行的会话；返回 false 表示那个会话已不在列表里。 */
  readonly openSession: (sessionId: string) => boolean
  onChanged(): void | Promise<void>
  onError(message: string | undefined): void
  onDragStart(): void
  onDragEnd(): void
  onDropBefore(): void
  onNudge(direction: 'up' | 'down' | 'left' | 'right'): void | Promise<void>
}

const PRIORITY_LABELS: Readonly<Record<string, string>> = {
  none: '',
  low: '低',
  medium: '中',
  high: '高',
  urgent: '紧急',
}

/** 派活按钮在这些 Lane 上出现。Running 已有活 Run，Review 等的是人。 */
const DISPATCHABLE: readonly Lane[] = ['backlog', 'todo', 'failed', 'done']

/** 用量的紧凑写法。数字大了用 k，看板上一眼能扫过去。 */
function formatTokens(usage: TokenUsage): string {
  const total = totalTokens(usage)
  return total >= 1000 ? `${(total / 1000).toFixed(1)}k` : String(total)
}

/** 卡片组件。 */
export function IssueCard(props: IssueCardProps): ReturnType<typeof createElement> {
  const { issue, client, onChanged, onError } = props
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)

  /** 跑一次写操作：期间禁用按钮，失败把原因抬到上层显示。 */
  const act = async (operation: () => Promise<{ ok: boolean; message?: string }>): Promise<void> => {
    if (busy) return
    setBusy(true)
    onError(undefined)
    try {
      const result = await operation()
      if (!result.ok) onError(result.message ?? '操作失败')
      await onChanged()
    } finally {
      setBusy(false)
    }
  }

  const running = activeRun(issue)
  const lastRun = issue.runs[issue.runs.length - 1]
  const settledUsage = sumUsage(issue.runs.map(run => run.usage))
  const priority = PRIORITY_LABELS[issue.priority] ?? ''

  if (editing) {
    return createElement(EditIssueForm, {
      issue,
      sandboxPresets: props.sandboxPresets,
      client,
      onDone: () => { setEditing(false); void onChanged() },
      onCancel: () => setEditing(false),
      onError,
    })
  }

  return createElement(
    'article',
    {
      'data-vela-card': issue.id,
      'data-lane': issue.lane,
      'data-dragging': String(props.isDragging),
      // Running 的卡片不可拖动：拖出去会让活 Run 成为孤儿。
      draggable: issue.lane !== 'running',
      tabIndex: 0,
      onDragStart: () => props.onDragStart(),
      onDragEnd: () => props.onDragEnd(),
      onDrop: (event: { preventDefault(): void; stopPropagation(): void }) => {
        event.preventDefault()
        event.stopPropagation()
        props.onDropBefore()
      },
      onDragOver: (event: { preventDefault(): void }) => { event.preventDefault() },
      // 键盘等价操作：Alt + 方向键。焦点在卡片上时可用。
      onKeyDown: (event: {
        key: string; altKey: boolean; preventDefault(): void
      }) => {
        if (!event.altKey) return
        const map: Readonly<Record<string, 'up' | 'down' | 'left' | 'right'>> = {
          ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
        }
        const direction = map[event.key]
        if (direction === undefined) return
        event.preventDefault()
        void props.onNudge(direction)
      },
      'aria-label': `${issue.title}（${issue.lane}）`,
    },
    createElement('div', { 'data-vela-card-title': '' }, issue.title),
    createElement(
      'div',
      { 'data-vela-card-meta': '' },
      ...(props.showWorkspace ? [createElement('code', { key: 'ws' }, issue.workspace)] : []),
      ...(priority === '' ? [] : [createElement(
        'span',
        { key: 'prio', 'data-vela-chip': '', 'data-tone': issue.priority },
        priority,
      )]),
      ...(issue.runs.length === 0
        ? []
        : [createElement('span', { key: 'runs', 'data-vela-chip': '' }, `${issue.runs.length} 次执行`)]),
      ...(issue.maxAttempts > 0
        ? [createElement('span', { key: 'retry', 'data-vela-chip': '' }, `自动重试 ≤${issue.maxAttempts}`)]
        : []),
      ...(issue.exec.sandbox === undefined
        ? []
        : [createElement('span', { key: 'sb', 'data-vela-chip': '' }, issue.exec.sandbox)]),
    ),
    // 用量：进行中显示实时值（不落盘），结束后显示累计快照。
    ...(running !== undefined && props.liveUsage !== undefined
      ? [createElement(
        'div',
        { key: 'live', 'data-vela-live': '' },
        `${formatTokens(props.liveUsage)} tokens`,
      )]
      : []),
    ...(running === undefined && settledUsage !== undefined
      ? [createElement(
        'div',
        { key: 'usage', 'data-vela-card-meta': '' },
        createElement('span', null, `${formatTokens(settledUsage)} tokens`),
      )]
      : []),
    // Run 异常终止导致用量缺失时显示未知，既不显示 0 也不回退到实时计数。
    ...(running === undefined && issue.runs.length > 0 && settledUsage === undefined
      ? [createElement('div', { key: 'unknown', 'data-vela-hint': '' }, 'token 用量未知')]
      : []),
    ...(issue.lane === 'failed' && lastRun?.failure !== undefined
      ? [createElement('div', { key: 'fail', 'data-vela-failure': '' }, lastRun.failure)]
      : []),
    createElement(
      'div',
      { 'data-vela-actions': '' },
      // 看看这次执行：跳进 Run 自己的会话并关上看板（ADR-0002 定的动线）。
      // Run 是顶层会话，因此它就像任何会话一样能被点开。
      ...(lastRun === undefined
        ? []
        : [createElement('button', {
          key: 'open',
          type: 'button',
          onClick: () => {
            if (!props.openSession(lastRun.sessionId)) {
              onError('这次执行的会话已不在会话列表里')
            }
          },
        }, issue.lane === 'running' ? '看看在干什么' : '看会话')]),
      // 派活。未挂载 apiProxy 的部署直接没有这个按钮，而不是给一个点了就报错的入口。
      ...(props.canDispatch && DISPATCHABLE.includes(issue.lane)
        ? [createElement('button', {
          key: 'run',
          type: 'button',
          disabled: busy,
          'data-tone': 'primary',
          onClick: () => void act(() => client.dispatch(issue.id)),
        }, issue.runs.length === 0 ? '派活' : '重新派活')]
        : []),
      ...(issue.lane === 'running'
        ? [createElement('button', {
          key: 'stop',
          type: 'button',
          disabled: busy,
          'data-tone': 'danger',
          onClick: () => void act(() => client.cancel(issue.id)),
        }, '停止')]
        : []),
      // Gate：通往终态的唯一入口（ADR-0007）。
      ...(issue.lane === 'review'
        ? [
          createElement('button', {
            key: 'accept',
            type: 'button',
            disabled: busy,
            'data-tone': 'primary',
            onClick: () => void act(() => client.gate(issue.id, 'accept')),
          }, '接受'),
          createElement('button', {
            key: 'reject',
            type: 'button',
            disabled: busy,
            onClick: () => void act(() => client.gate(issue.id, 'reject')),
          }, '退回'),
        ]
        : []),
      ...(issue.lane === 'running'
        ? []
        : [
          createElement('button', {
            key: 'edit', type: 'button', disabled: busy, onClick: () => setEditing(true),
          }, '编辑'),
          createElement('button', {
            key: 'del',
            type: 'button',
            disabled: busy,
            'data-tone': 'danger',
            'aria-label': `删除 ${issue.title}`,
            onClick: () => void act(() => client.deleteIssue(issue.id)),
          }, '删除'),
        ]),
    ),
  )
}
