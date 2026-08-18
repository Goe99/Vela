/**
 * 时间轴 UI 的渲染契约（票 10 / ADR-0019）。
 *
 * 与其他 render 测试同一套路子：断言那些**看得见的承诺**确实在输出里。这里特别
 * 盯两条：失败的泳道必须能被区分出来，以及「这是 Vela 观察到的时刻」那句说明
 * 必须在——它不是免责声明，是防止有人拿这张图去做性能归因。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { BoardClient } from '../../src/client/board-client.ts'
import { IssueDrawer } from '../../src/client/components/IssueDrawer.tsx'
import { SquadTimeline } from '../../src/client/components/SquadTimeline.tsx'
import type { MemberSpan } from '../../src/domain/timeline.ts'
import type { Issue } from '../../src/domain/types.ts'
import { BOARD_VERSION } from '../../src/domain/types.ts'

const T0 = 1_700_000_000_000

function stubClient(): BoardClient {
  return new BoardClient(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      board: { version: BOARD_VERSION, nextNumber: 1, issues: [] },
      liveUsage: {},
      sandboxPresets: [],
      squads: [],
      canDispatch: true,
    }),
  }))
}

/** 两条串行的泳道：一条完成、一条出错，后者没反查到队员名。 */
const twoLanes: readonly MemberSpan[] = [
  {
    runId: 'c1',
    sessionId: 'child-1',
    label: '创建 slot-a.txt',
    member: 'worker_a',
    observedStart: T0,
    observedEnd: T0 + 2400,
    stopReason: 'completed',
    summary: '建好了 slot-a.txt，内容是一行 a。',
  },
  {
    runId: 'c2',
    sessionId: 'child-2',
    label: '创建 slot-b.txt',
    member: undefined,
    observedStart: T0 + 2400,
    observedEnd: T0 + 5000,
    stopReason: 'error',
  },
]

type TimelineProps = Parameters<typeof SquadTimeline>[0]

function timelineProps(spans: readonly MemberSpan[], now = T0 + 5000): TimelineProps {
  return { spans, now, openSession: () => true }
}

describe('SquadTimeline', () => {
  it('每个队员一条泳道，带任务描述', () => {
    const html = renderToStaticMarkup(createElement(SquadTimeline, timelineProps(twoLanes)))
    assert.ok(html.includes('创建 slot-a.txt'))
    assert.ok(html.includes('创建 slot-b.txt'))
    assert.equal(html.split('data-vela-lane=').length - 1, 2)
  })

  it('反查到队员名时一并显示；查不到时只显示任务描述', () => {
    const html = renderToStaticMarkup(createElement(SquadTimeline, timelineProps(twoLanes)))
    assert.ok(html.includes('worker_a'), '查到的要显示')
    // 第二条没有队员名，但泳道仍然完整可用——名字只是锦上添花。
    assert.equal(html.split('data-vela-lane-member').length - 1, 1)
  })

  it('失败的泳道用 data-tone 区分，且写出停止原因', () => {
    const html = renderToStaticMarkup(createElement(SquadTimeline, timelineProps(twoLanes)))
    assert.ok(html.includes('data-tone="ok"'))
    assert.ok(html.includes('data-tone="bad"'))
    assert.ok(html.includes('出错'))
  })

  it('队员的总结显示在泳道下方；没写的泳道不造占位符', () => {
    const html = renderToStaticMarkup(createElement(SquadTimeline, timelineProps(twoLanes)))
    assert.ok(html.includes('建好了 slot-a.txt'), '完成的泳道要带总结')
    // 只有一条泳道有总结。
    assert.equal(html.split('data-vela-lane-summary').length - 1, 1)
  })

  it('还在跑的泳道标成在跑，且用另一种色调', () => {
    const running: readonly MemberSpan[] = [{
      ...twoLanes[0]!,
      observedEnd: undefined,
      stopReason: undefined,
    }]
    const html = renderToStaticMarkup(createElement(SquadTimeline, timelineProps(running)))
    assert.ok(html.includes('data-tone="running"'))
    assert.ok(html.includes('在跑'))
  })

  it('每条泳道是按钮，点它跳去那个队员自己的会话', () => {
    const html = renderToStaticMarkup(createElement(SquadTimeline, timelineProps(twoLanes)))
    assert.equal(html.split('data-vela-lane-label').length - 1, 2)
    assert.ok(/<button[^>]*data-vela-lane-label/.test(html))
  })

  it('条的位置真的落到了 DOM 上，不是算了却没渲', () => {
    const html = renderToStaticMarkup(createElement(SquadTimeline, timelineProps(twoLanes)))
    // 具体比例由 layoutSpans 的测试钉住；这里只确认样式确实输出了。
    assert.ok(/margin-inline-start:\s*0%/.test(html))
    assert.ok(/inline-size:\s*\d/.test(html))
  })

  it('未知的停止原因原样显示，不吞掉——上游可能加新值', () => {
    const odd: readonly MemberSpan[] = [{ ...twoLanes[0]!, stopReason: 'brand-new-reason' }]
    const html = renderToStaticMarkup(createElement(SquadTimeline, timelineProps(odd)))
    assert.ok(html.includes('brand-new-reason'))
  })

  it('照实标注时刻是「Vela 观察到的」——防止有人拿它做性能归因', () => {
    const html = renderToStaticMarkup(createElement(SquadTimeline, timelineProps(twoLanes)))
    assert.ok(html.includes('Vela 观察到的时刻'))
    assert.ok(html.includes('不适合拿来做性能归因'))
  })

  it('一个队员都没派出时给明确空状态，而不是一条空轴', () => {
    const html = renderToStaticMarkup(createElement(SquadTimeline, timelineProps([])))
    assert.ok(html.includes('一个队员也没派出'))
    assert.ok(!html.includes('data-vela-lane='), '不该渲出空泳道')
  })
})

describe('抽屉里的时间轴', () => {
  /** 一张跑过一次、会话 id 为 parent-1 的卡。 */
  const squadRun: Issue = {
    id: 'i9',
    number: 9,
    title: '同时做三件事',
    description: '',
    workspace: '/w',
    lane: 'review',
    priority: 'none',
    position: 1,
    createdAt: 1,
    updatedAt: 1,
    maxAttempts: 0,
    exec: { squad: 'vela-slot-test' },
    runs: [{
      id: 'r1',
      sessionId: 'parent-1',
      startedAt: T0,
      endedAt: T0 + 5000,
      status: 'settled',
      outcome: 'completed',
    }],
  }

  type DrawerProps = Parameters<typeof IssueDrawer>[0]

  function drawerProps(overrides: Partial<DrawerProps> = {}): DrawerProps {
    return {
      issue: squadRun,
      liveUsage: undefined,
      client: stubClient(),
      openSession: () => true,
      onChanged: () => undefined,
      onClose: () => undefined,
      now: T0 + 5000,
      ...overrides,
    }
  }

  it('派给了小队的执行上出现时间轴', () => {
    const html = renderToStaticMarkup(createElement(IssueDrawer, drawerProps({
      timelines: { 'parent-1': twoLanes },
    })))
    assert.ok(html.includes('创建 slot-a.txt'))
    assert.ok(html.includes('data-vela-lane='))
  })

  it('单 Agent 的执行上不画时间轴——那里没有并行关系可画（ADR-0019）', () => {
    const html = renderToStaticMarkup(createElement(IssueDrawer, drawerProps({ timelines: {} })))
    assert.ok(!html.includes('data-vela-lane='))
    assert.ok(!html.includes('Vela 观察到的时刻'))
    // 但「看会话」那个按钮仍然在——那是单 Agent 执行里的全部去处。
    assert.ok(html.includes('看会话'))
  })

  it('派了小队但一个队员也没派出时给空状态，而不是什么都不画', () => {
    // 「有这个键但数组为空」与「没有这个键」传达的信息不同，UI 必须分开处理。
    const html = renderToStaticMarkup(createElement(IssueDrawer, drawerProps({
      timelines: { 'parent-1': [] },
    })))
    assert.ok(html.includes('一个队员也没派出'))
  })

  it('完全不传 timelines 时也不崩——这个部署可能没接记录器', () => {
    const html = renderToStaticMarkup(createElement(IssueDrawer, drawerProps()))
    assert.ok(!html.includes('data-vela-lane='))
    assert.ok(html.includes('V-9'))
  })
})
