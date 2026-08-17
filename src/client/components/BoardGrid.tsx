/**
 * Board 的六列网格（票 03/04/06/12）。Lane 集合固定（ADR-0009），因此直接
 * 遍历 LANES 常量。
 *
 * 拖拽用**浏览器原生 drag-and-drop**，不引第三方库：本来就要为票 06 单独做
 * 键盘重排，原生方案让 client bundle 保持零新增依赖。合法落点在 dragover 阶段
 * 就按状态机判定，非法落点直接拒绝——不出现「先接受再回弹」。
 */

import { createElement, useState } from 'react'
import type { Issue, Lane, TokenUsage } from '../../domain/types.ts'
import { LANES } from '../../domain/types.ts'
import { byPosition } from '../../domain/ordering.ts'
import { canOperatorMove } from '../../domain/lanes.ts'
import type { BoardClient } from '../board-client.ts'
import { IssueCard } from './IssueCard.tsx'
import { NewIssueForm } from './NewIssueForm.tsx'
import type { SquadShape } from '../board-client.ts'

const LANE_LABELS: Readonly<Record<Lane, string>> = {
  backlog: 'Backlog',
  todo: 'Todo',
  running: 'Running',
  review: '待验收',
  done: 'Done',
  failed: 'Failed',
}

/**
 * 每列的状态符号，显示在列名前面。用 unicode 而不是图标库，保持零依赖。
 *
 * 形状跟着语义走：空心是「还没排上」，实心是「准备好了」，三角是「正在进行」，
 * 半圆是「等一个判断」，勾与叉是两种终局。形状与颜色**双重**编码——只靠颜色时，
 * 色弱的人分不清「进行中」和「待验收」。
 */
const LANE_ICONS: Readonly<Record<Lane, string>> = {
  backlog: '○',
  todo: '●',
  running: '▶',
  review: '◐',
  done: '✓',
  failed: '✕',
}

/** BoardGrid 的 props。 */
export interface BoardGridProps {
  readonly issues: readonly Issue[]
  readonly showWorkspace: boolean
  readonly defaultWorkspace: string
  readonly sandboxPresets: readonly string[]
  /** 可选的小队，供建卡与编辑时选派给哪支队。 */
  readonly squads: readonly SquadShape[]
  readonly canDispatch: boolean
  readonly liveUsage: Readonly<Record<string, TokenUsage>>
  /** 详情抽屉里那张卡的 id（用于高亮）；未打开时 undefined。 */
  readonly selectedId: string | undefined
  /** 选中一张卡——传 undefined 关抽屉。 */
  readonly onSelect: (id: string | undefined) => void
  /** 跳到一次执行的会话；返回 false 表示那个会话已不在列表里。 */
  readonly openSession: (sessionId: string) => boolean
  readonly client: BoardClient
  readonly onChanged: () => void | Promise<void>
}

/** 正在被拖动的卡片。 */
interface Dragging {
  readonly id: string
  readonly from: Lane
}

/** 六列网格。 */
export function BoardGrid(props: BoardGridProps): ReturnType<typeof createElement> {
  const { issues, client, onChanged } = props
  const [dragging, setDragging] = useState<Dragging | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)

  /** 把一张卡片放到某列的某个位置。 */
  const drop = async (lane: Lane, beforeId: string | undefined): Promise<void> => {
    const active = dragging
    setDragging(undefined)
    if (active === undefined) return
    if (!canOperatorMove(active.from, lane)) return
    const result = await client.moveIssue(active.id, {
      lane,
      ...(beforeId === undefined ? {} : { beforeId }),
    })
    setError(result.ok ? undefined : result.message)
    await onChanged()
  }

  /** 键盘重排/跨列移动（票 06 要求键盘可完成同样的操作）。 */
  const nudge = async (issue: Issue, direction: 'up' | 'down' | 'left' | 'right'): Promise<void> => {
    if (direction === 'left' || direction === 'right') {
      const index = LANES.indexOf(issue.lane)
      const target = LANES[direction === 'left' ? index - 1 : index + 1]
      if (target === undefined || !canOperatorMove(issue.lane, target)) return
      const result = await client.moveIssue(issue.id, { lane: target })
      setError(result.ok ? undefined : result.message)
      await onChanged()
      return
    }
    const column = issues.filter(candidate => candidate.lane === issue.lane).slice().sort(byPosition)
    const at = column.findIndex(candidate => candidate.id === issue.id)
    // 上移 = 落到上一张之前；下移 = 落到下两张之前（跳过自己）。
    const anchor = direction === 'up' ? column[at - 1] : column[at + 2]
    if (direction === 'up' && anchor === undefined) return
    if (direction === 'down' && at === column.length - 1) return
    const result = await client.moveIssue(issue.id, {
      lane: issue.lane,
      ...(anchor === undefined ? {} : { beforeId: anchor.id }),
    })
    setError(result.ok ? undefined : result.message)
    await onChanged()
  }

  return createElement(
    'div',
    { 'data-vela-grid': '' },
    ...LANES.map(lane => createElement(
      LaneColumn,
      {
        ...props,
        key: lane,
        lane,
        issues: issues.filter(issue => issue.lane === lane).slice().sort(byPosition),
        dragging,
        onDrop: drop,
        onDragEnd: () => setDragging(undefined),
        onDragStart: (id: string, from: Lane) => setDragging({ id, from }),
        onNudge: nudge,
        onError: setError,
        error,
      },
    )),
  )
}

interface LaneColumnProps extends BoardGridProps {
  readonly lane: Lane
  readonly issues: readonly Issue[]
  readonly dragging: Dragging | undefined
  readonly error: string | undefined
  onDrop(lane: Lane, beforeId: string | undefined): void | Promise<void>
  onDragStart(id: string, from: Lane): void
  onDragEnd(): void
  onNudge(issue: Issue, direction: 'up' | 'down' | 'left' | 'right'): void | Promise<void>
  onError(message: string | undefined): void
}

function LaneColumn(props: LaneColumnProps): ReturnType<typeof createElement> {
  const { lane, issues, dragging, onDrop, onDragStart, onDragEnd, onNudge, onError, error } = props
  const [over, setOver] = useState(false)

  // 合法性在这里判定一次，dragover 与样式共用同一个答案。
  const allowed = dragging !== undefined && canOperatorMove(dragging.from, lane)
  const dropState = dragging === undefined || !over ? undefined : allowed ? 'ok' : 'no'

  return createElement(
    'section',
    {
      'data-vela-lane': lane,
      ...(dropState === undefined ? {} : { 'data-drop': dropState }),
      onDragOver: (event: { preventDefault(): void; dataTransfer?: { dropEffect: string } }) => {
        setOver(true)
        // 只有合法落点才 preventDefault——不合法时浏览器显示禁止光标。
        if (!allowed) return
        event.preventDefault()
        if (event.dataTransfer !== undefined) event.dataTransfer.dropEffect = 'move'
      },
      onDragLeave: () => setOver(false),
      onDrop: (event: { preventDefault(): void }) => {
        event.preventDefault()
        setOver(false)
        if (allowed) void onDrop(lane, undefined)
      },
    },
    createElement(
      'h3',
      { 'data-vela-lane-head': '' },
      createElement('span', { 'data-vela-lane-icon': '', 'aria-hidden': 'true' }, LANE_ICONS[lane]),
      LANE_LABELS[lane],
      createElement('span', { 'data-vela-count': '' }, String(issues.length)),
    ),
    createElement(
      'div',
      { 'data-vela-lane-body': '' },
      // 建卡入口只在 Backlog——新 Issue 只进 Backlog（ADR-0012）。
      ...(lane === 'backlog'
        ? [createElement(NewIssueForm, {
          key: '__new',
          client: props.client,
          defaultWorkspace: props.defaultWorkspace,
          sandboxPresets: props.sandboxPresets,
          squads: props.squads,
          onChanged: props.onChanged,
          onError,
        })]
        : []),
      ...(lane !== 'backlog' && issues.length === 0
        ? [createElement('div', { key: '__empty', 'data-vela-empty': '' }, '空')]
        : []),
      ...issues.map((issue, index) => createElement(IssueCard, {
        key: issue.id,
        issue,
        showWorkspace: props.showWorkspace,
        sandboxPresets: props.sandboxPresets,
        squads: props.squads,
        canDispatch: props.canDispatch,
        liveUsage: props.liveUsage[issue.id],
        isSelected: props.selectedId === issue.id,
        onOpenDetail: () => props.onSelect(issue.id),
        openSession: props.openSession,
        client: props.client,
        onChanged: props.onChanged,
        onError,
        isDragging: dragging?.id === issue.id,
        onDragStart: () => onDragStart(issue.id, issue.lane),
        onDragEnd,
        // 落在这张卡片之前。
        onDropBefore: () => { if (dragging !== undefined) void onDrop(lane, issue.id) },
        onNudge: direction => onNudge(issue, direction),
        canMoveUp: index > 0,
        canMoveDown: index < issues.length - 1,
      })),
      ...(lane === 'backlog' && error !== undefined
        ? [createElement('div', { key: '__err', 'data-vela-error': '' }, error)]
        : []),
    ),
  )
}
