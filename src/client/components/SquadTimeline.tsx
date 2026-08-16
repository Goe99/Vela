/**
 * 小队并行时间轴（票 10 / ADR-0019）。
 *
 * 只画一件 DSH 画不出来的事：**这次执行里各个队员谁在什么时候跑、谁和谁重叠**。
 * 某个队员具体做了哪些步骤一笔不画——点泳道跳去 DSH 看官方那份轨迹视图，比我们
 * 重做一份更好（`dsh-client-ui-trajectory` 是内部包，第三方插件 import 不到）。
 *
 * ## 时刻必须照实标注
 *
 * 横轴上的位置来自 **Vela 观察到的时刻**，不是队员真正起跑的时刻。差值是事件派发
 * 延迟，进程内可忽略，但这是近似值。组件底部有一句固定说明——不是免责声明，而是
 * 防止有人拿这张图去做性能归因。
 */

import { createElement } from 'react'
import type { MemberSpan } from '../../domain/timeline.ts'
import { layoutSpans } from '../../domain/timeline.ts'

/** 时间轴的 props。 */
export interface SquadTimelineProps {
  readonly spans: readonly MemberSpan[]
  /** 当前时刻。还在跑的泳道画到这里，因此时间轴随轮询增长、跑完定格。 */
  readonly now: number
  /** 跳到某个队员自己的会话；返回 false 表示那个会话已不在列表里。 */
  readonly openSession: (sessionId: string) => boolean
}

/** 停止原因的中文说法。表里没有的原样显示——上游可能加新值。 */
const STOP_LABELS: Readonly<Record<string, string>> = {
  completed: '完成',
  error: '出错',
  cancelled: '被取消',
  aborted: '被中断',
  'infrastructure-error': '异常终止',
}

/** 一条泳道的状态类别，用于配色。 */
function toneOf(span: MemberSpan): 'running' | 'ok' | 'bad' {
  if (span.observedEnd === undefined) return 'running'
  return span.stopReason === 'completed' ? 'ok' : 'bad'
}

/** 耗时的紧凑写法。 */
function compactDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${Math.round(seconds * 10) / 10}s`
  return `${Math.floor(seconds / 60)}m${Math.floor(seconds % 60).toString().padStart(2, '0')}s`
}

/** 小队并行时间轴。 */
export function SquadTimeline(props: SquadTimelineProps): ReturnType<typeof createElement> {
  const { spans, now, openSession } = props

  if (spans.length === 0) {
    return createElement(
      'div',
      { 'data-vela-timeline-empty': '' },
      createElement('p', { 'data-vela-muted': '' }, '这次执行里队长一个队员也没派出。'),
      createElement(
        'p',
        { 'data-vela-muted': '' },
        '可能是它自己做完了，也可能是它没意识到手里有队员——后者通常意味着队长的职责说明该写得更明确。',
      ),
    )
  }

  const geometry = layoutSpans(spans, now)
  // 整根轴的跨度，给刻度用。
  const first = Math.min(...spans.map(span => span.observedStart))
  const last = Math.max(...spans.map(span => span.observedEnd ?? now))

  return createElement(
    'div',
    { 'data-vela-timeline': '' },
    createElement(
      'div',
      { 'data-vela-timeline-scale': '' },
      createElement('span', undefined, '0'),
      createElement('span', undefined, compactDuration(last - first)),
    ),
    ...spans.map((span, index) => {
      const geo = geometry[index]!
      const tone = toneOf(span)
      const ended = span.observedEnd
      const duration = (ended ?? now) - span.observedStart
      return createElement(
        'div',
        { key: span.runId, 'data-vela-lane': '', 'data-tone': tone },
        // 左侧标签：任务描述为主，队员名为副。任务描述信息量更大，而队员名
        // 只在职责说明能唯一对上时才拿得到（DSH 不把工具名给 provider）。
        createElement(
          'button',
          {
            type: 'button',
            'data-vela-lane-label': '',
            // 会话可能已被清掉。跳不过去时不做声——上层的 onChanged 会把视图刷新，
            // 那条泳道自然消失，比弹一句"跳不过去"有用。
            onClick: () => { openSession(span.sessionId) },
            'aria-label': `打开「${span.label}」的会话`,
            title: span.member === undefined ? span.label : `${span.member}：${span.label}`,
          },
          ...(span.member === undefined
            ? []
            : [createElement('span', { key: 'who', 'data-vela-lane-member': '' }, span.member)]),
          createElement('span', { 'data-vela-lane-task': '' }, span.label),
        ),
        // 轨道：一条按比例定位的条。
        createElement(
          'div',
          { 'data-vela-lane-track': '' },
          createElement(
            'div',
            {
              'data-vela-lane-bar': '',
              style: { marginInlineStart: `${geo.offset}%`, inlineSize: `${geo.width}%` },
            },
          ),
        ),
        createElement(
          'span',
          { 'data-vela-lane-status': '' },
          ended === undefined
            ? `在跑 ${compactDuration(duration)}`
            : `${STOP_LABELS[span.stopReason ?? ''] ?? span.stopReason ?? '结果未知'} ${compactDuration(duration)}`,
        ),
      )
    }),
    // 这句不是免责声明，是防止有人拿这张图做性能归因（ADR-0019）。
    createElement(
      'p',
      { 'data-vela-timeline-note': '' },
      '横轴用的是 Vela 观察到的时刻，不是队员真正起跑的时刻——这是近似值，不适合拿来做性能归因。',
    ),
  )
}
