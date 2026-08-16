/**
 * Issue 详情抽屉（票 04）：点一张卡从右侧滑出，Board 仍留在视野里。
 *
 * 为什么是抽屉而不是整页：Board 是这个插件的主体，看细节时把它整块换掉会丢掉
 * 「这张卡在哪一列、旁边还有什么」这个上下文——而那正是 Operator 打开看板的
 * 理由。抽屉占右侧四成，左边六成的 Board 照常可读可点。
 *
 * 这里也是小队时间轴（票 10）的容器。
 *
 * ## 焦点与键盘
 *
 * 卡片自己带方向键操作（挪动它在看板上的位置）。抽屉一打开就把焦点移进来，
 * 于是那些键落在抽屉里而不是卡片上——「抽屉开着时 Board 的键盘操作不被误触发」
 * 靠的是焦点位置，不是逐个 stopPropagation。关闭时焦点还给原来那张卡，否则
 * 焦点会掉回 body，键盘用户就此失去位置。
 *
 * Escape 由 BoardPanel 统一处理：它知道抽屉开没开，因此能决定这一下是关抽屉
 * 还是关整个面板。两处各挂一个 listener 会变成一个顺序问题。
 */

import { createElement, useEffect, useRef, useState } from 'react'
import type { Issue, Run, TokenUsage } from '../../domain/types.ts'
import { formatIssueNumber } from '../../domain/types.ts'
import type { MemberSpan } from '../../domain/timeline.ts'
import { totalTokens } from '../../domain/usage.ts'
import type { BoardClient } from '../board-client.ts'
import { SquadTimeline } from './SquadTimeline.tsx'

/** 抽屉的 props。 */
export interface IssueDrawerProps {
  readonly issue: Issue
  /** 在途 Run 的实时用量；不落盘，只用于展示。 */
  readonly liveUsage: TokenUsage | undefined
  readonly client: BoardClient
  /**
   * 小队并行时间轴，按会话 id 索引（ADR-0019）。
   *
   * 「没有这个键」与「有键但数组为空」是两回事，而且传达的信息不同：前者是
   * 「这次不是小队 Run」，后者是「派了小队但一个队员也没派出」。
   */
  readonly timelines?: Readonly<Record<string, readonly MemberSpan[]>>
  /** 当前时刻。时间轴里还在跑的泳道画到这里。 */
  readonly now?: number
  /** 跳到一次执行的会话；返回 false 表示那个会话已不在列表里。 */
  readonly openSession: (sessionId: string) => boolean
  onChanged(): void | Promise<void>
  onClose(): void
}

/** Lane 的中文名。与 BoardGrid 的列头保持一致的说法。 */
const LANE_LABELS: Record<Issue['lane'], string> = {
  backlog: '待办',
  todo: '准备好',
  running: '进行中',
  review: '待验收',
  done: '完成',
  failed: '失败',
}

/** Run 结局的中文名。 */
const OUTCOME_LABELS: Record<string, string> = {
  completed: '正常结束',
  error: '出错',
  aborted: '被中断',
  timeout: '超时',
}

/** 把毫秒时长写成人能一眼读的形式。 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = Math.round(ms / 100) / 10
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  // 秒数用 floor 而不是 round：round 会在接近整分时溢出——119.7 秒会变成
  // 「1m60s」。取已过的完整秒数也更符合「跑了多久」这个问法的直觉。
  const rest = Math.floor(seconds % 60)
  return `${minutes}m${rest.toString().padStart(2, '0')}s`
}

/** 时刻写成本地时间。日期只在不是今天时才带上——多数 Run 是刚跑的。 */
function formatMoment(at: number): string {
  const date = new Date(at)
  const time = date.toLocaleTimeString(undefined, { hour12: false })
  const today = new Date()
  const sameDay = date.getFullYear() === today.getFullYear()
    && date.getMonth() === today.getMonth()
    && date.getDate() === today.getDate()
  return sameDay ? time : `${date.toLocaleDateString()} ${time}`
}

/** 一行「标签：值」。值为空时整行不渲染，免得抽屉里挂着一排空标签。 */
function field(label: string, value: string | undefined): ReturnType<typeof createElement> | undefined {
  if (value === undefined || value.trim().length === 0) return undefined
  return createElement(
    'div',
    { key: label, 'data-vela-field': '' },
    createElement('span', { 'data-vela-field-label': '' }, label),
    createElement('span', { 'data-vela-field-value': '' }, value),
  )
}

/** Issue 详情抽屉。 */
export function IssueDrawer(props: IssueDrawerProps): ReturnType<typeof createElement> {
  const { issue, client, onChanged, onClose } = props
  const [title, setTitle] = useState(issue.title)
  const [description, setDescription] = useState(issue.description)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const rootRef = useRef<HTMLDivElement | null>(null)

  // 换到另一张卡时把草稿换成那张卡的内容。没有这一步，抽屉里会留着上一张卡
  // 的标题，而保存按钮会把它写到当前这张上。
  useEffect(() => {
    setTitle(issue.title)
    setDescription(issue.description)
    setError(undefined)
  }, [issue.id, issue.title, issue.description])

  // 打开就把焦点移进来，让卡片的方向键操作不再收到按键。
  useEffect(() => {
    rootRef.current?.focus()
  }, [])

  const dirty = title !== issue.title || description !== issue.description

  const save = async (): Promise<void> => {
    if (!dirty) return
    setBusy(true)
    const result = await client.updateIssue(issue.id, { title, description })
    setBusy(false)
    if (!result.ok) {
      setError(result.message)
      return
    }
    setError(undefined)
    await onChanged()
  }

  // 新的在前：最近一次执行才是 Operator 要看的那次。
  const runs = [...issue.runs].reverse()

  return createElement(
    'aside',
    {
      ref: rootRef,
      tabIndex: -1,
      role: 'complementary',
      'aria-label': `${formatIssueNumber(issue.number)} 详情`,
      'data-vela-drawer': '',
    },
    createElement(
      'header',
      { 'data-vela-drawer-head': '' },
      createElement('span', { 'data-vela-number': '' }, formatIssueNumber(issue.number)),
      createElement('span', { 'data-vela-drawer-lane': '' }, LANE_LABELS[issue.lane]),
      createElement('span', { 'data-vela-spacer': '' }),
      createElement('button', {
        type: 'button',
        onClick: onClose,
        'aria-label': '关闭详情',
      }, '关闭'),
    ),

    // ── 可就地编辑的标题与描述 ────────────────────────────────
    createElement(
      'div',
      { 'data-vela-drawer-body': '' },
      createElement(
        'label',
        { 'data-vela-drawer-label': '' },
        '标题',
        createElement('input', {
          value: title,
          disabled: busy,
          'aria-label': '标题',
          onChange: (event: { target: { value: string } }) => setTitle(event.target.value),
        }),
      ),
      createElement(
        'label',
        { 'data-vela-drawer-label': '' },
        '描述',
        createElement('textarea', {
          value: description,
          rows: 6,
          disabled: busy,
          'aria-label': '描述',
          onChange: (event: { target: { value: string } }) => setDescription(event.target.value),
        }),
      ),
      createElement(
        'div',
        { 'data-vela-drawer-actions': '' },
        createElement('button', {
          type: 'button',
          disabled: busy || !dirty,
          'data-tone': 'primary',
          onClick: () => { void save() },
        }, dirty ? '保存' : '已保存'),
        ...(dirty
          ? [createElement('button', {
            key: 'revert',
            type: 'button',
            disabled: busy,
            onClick: () => { setTitle(issue.title); setDescription(issue.description) },
          }, '撤销改动')]
          : []),
      ),
      ...(error === undefined
        ? []
        : [createElement('p', { key: 'error', 'data-vela-error': '' }, error)]),

      // ── 只读的执行配置 ─────────────────────────────────────
      createElement('h3', { 'data-vela-drawer-section': '' }, '执行配置'),
      createElement(
        'div',
        { 'data-vela-fields': '' },
        ...[
          field('Workspace', issue.workspace),
          field('优先级', issue.priority),
          field('小队', issue.exec.squad),
          field('Agent preset', issue.exec.agentPreset),
          field('权限档位', issue.exec.sandbox),
          field('超时', issue.exec.timeoutMs === undefined ? undefined : formatDuration(issue.exec.timeoutMs)),
        ].filter((node): node is ReturnType<typeof createElement> => node !== undefined),
        // 一项都没配时说清楚「全用默认」，而不是留一片空白让人以为没加载出来。
        ...(issue.exec.squad === undefined && issue.exec.agentPreset === undefined
          && issue.exec.sandbox === undefined && issue.exec.timeoutMs === undefined
          ? [createElement('p', { key: 'defaults', 'data-vela-muted': '' }, '这张卡没有单独配置，全部用全局默认。')]
          : []),
      ),

      // ── 历次执行 ───────────────────────────────────────────
      createElement('h3', { 'data-vela-drawer-section': '' }, `历次执行（${issue.runs.length}）`),
      ...(runs.length === 0
        ? [createElement(
          'p',
          { key: 'no-runs', 'data-vela-muted': '' },
          '还没有派过活。把卡片拖到「准备好」再点派活，这里会记下每一次执行。',
        )]
        : runs.map((run, index) => runRow(run, issue.runs.length - index, props))),
    ),
  )
}

/**
 * 一次执行的记录。
 *
 * @param ordinal - 第几次执行（从 1 起，按发生顺序）。展示成「第 N 次」比一个
 *   随机 id 有用得多——Operator 说的是「第二次跑挂了」。
 */
function runRow(
  run: Run,
  ordinal: number,
  props: IssueDrawerProps,
): ReturnType<typeof createElement> {
  const running = run.status === 'running'
  // 在途的那次用实时用量；已结算的用落盘的那份（ADR-0011：结算后不可变）。
  const usage = running ? props.liveUsage : run.usage
  const tokens = usage === undefined ? undefined : totalTokens(usage)
  const ended = run.endedAt
  // 拿这次执行的会话 id 去查泳道。查不到就是「不是小队执行」，不画时间轴。
  const spans = props.timelines?.[run.sessionId]
  return createElement(
    'div',
    { key: run.id, 'data-vela-run': '', 'data-outcome': run.outcome ?? (running ? 'running' : 'unknown') },
    createElement(
      'div',
      { 'data-vela-run-head': '' },
      createElement('span', { 'data-vela-run-ordinal': '' }, `第 ${ordinal} 次`),
      createElement(
        'span',
        { 'data-vela-run-outcome': '' },
        running ? '正在跑' : OUTCOME_LABELS[run.outcome ?? ''] ?? '结果未知',
      ),
      createElement('span', { 'data-vela-spacer': '' }),
      createElement('button', {
        type: 'button',
        // 会话可能已经被清掉：跳不过去时说出来，而不是静默无反应。
        onClick: () => {
          if (!props.openSession(run.sessionId)) {
            props.onChanged()
          }
        },
        'aria-label': `打开第 ${ordinal} 次执行的会话`,
      }, '看会话'),
    ),
    createElement(
      'div',
      { 'data-vela-fields': '' },
      ...[
        field('开始', formatMoment(run.startedAt)),
        field('结束', ended === undefined ? undefined : formatMoment(ended)),
        field('耗时', ended === undefined ? undefined : formatDuration(ended - run.startedAt)),
        field('Token', tokens === undefined ? undefined : tokens.toLocaleString()),
      ].filter((node): node is ReturnType<typeof createElement> => node !== undefined),
    ),
    ...(run.failure === undefined
      ? []
      : [createElement('p', { key: 'failure', 'data-vela-run-failure': '' }, run.failure)]),
    // 时间轴只在**派给了小队**的执行上出现（ADR-0019）。单 Agent 的执行里没有
    // 并行关系可画，那里上面那个「看会话」按钮就是全部。
    ...(spans === undefined
      ? []
      : [createElement(SquadTimeline, {
        key: 'timeline',
        spans,
        now: props.now ?? Date.now(),
        openSession: props.openSession,
      })]),
  )
}
