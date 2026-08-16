/**
 * 小队并行时间轴：记录语义与布局几何（票 10 / ADR-0019）。
 *
 * 两层都是纯逻辑，所以能逐条钉住。UI 那一侧在 render 测试里。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_SPANS_PER_RUN, TimelineRecorder, layoutSpans } from '../../src/domain/timeline.ts'
import type { MemberSpan } from '../../src/domain/timeline.ts'

function span(overrides: Partial<MemberSpan> = {}): MemberSpan {
  return {
    runId: overrides.runId ?? 'r1',
    sessionId: overrides.sessionId ?? 's1',
    label: overrides.label ?? '建一个文件',
    member: overrides.member,
    observedStart: overrides.observedStart ?? 0,
    observedEnd: overrides.observedEnd,
    stopReason: overrides.stopReason,
  }
}

describe('时间轴：记录', () => {
  it('记下起跑与结束', () => {
    const recorder = new TimelineRecorder()
    recorder.start('p1', { runId: 'a', sessionId: 'sa', label: '甲', member: 'w1', at: 100 })
    recorder.end('p1', 'a', 300, 'completed')
    const spans = recorder.spansFor('p1')
    assert.equal(spans.length, 1)
    assert.equal(spans[0]?.observedStart, 100)
    assert.equal(spans[0]?.observedEnd, 300)
    assert.equal(spans[0]?.stopReason, 'completed')
    assert.equal(spans[0]?.member, 'w1')
  })

  it('按观察到的起跑时刻升序返回', () => {
    const recorder = new TimelineRecorder()
    recorder.start('p1', { runId: 'c', sessionId: 'sc', label: '丙', member: undefined, at: 300 })
    recorder.start('p1', { runId: 'a', sessionId: 'sa', label: '甲', member: undefined, at: 100 })
    recorder.start('p1', { runId: 'b', sessionId: 'sb', label: '乙', member: undefined, at: 200 })
    assert.deepEqual(recorder.spansFor('p1').map(s => s.runId), ['a', 'b', 'c'])
  })

  it('同一个 runId 重复上报起跑时忽略后来的那次', () => {
    const recorder = new TimelineRecorder()
    recorder.start('p1', { runId: 'a', sessionId: 'sa', label: '甲', member: undefined, at: 100 })
    recorder.start('p1', { runId: 'a', sessionId: 'sa', label: '甲', member: undefined, at: 999 })
    const spans = recorder.spansFor('p1')
    assert.equal(spans.length, 1)
    // 覆盖会让这条泳道的起点往后跳，而起跑时刻只有第一次是真的。
    assert.equal(spans[0]?.observedStart, 100)
  })

  it('重复上报结束时忽略后来的那次', () => {
    const recorder = new TimelineRecorder()
    recorder.start('p1', { runId: 'a', sessionId: 'sa', label: '甲', member: undefined, at: 100 })
    recorder.end('p1', 'a', 300, 'completed')
    recorder.end('p1', 'a', 999, 'error')
    const spans = recorder.spansFor('p1')
    assert.equal(spans[0]?.observedEnd, 300)
    assert.equal(spans[0]?.stopReason, 'completed')
  })

  it('结束找不到对应起跑时什么也不做——不凭空造一条没有起点的泳道', () => {
    const recorder = new TimelineRecorder()
    // 起跑发生在这个进程之前（ADR-0019：漏掉的起跑事件无法追补）。
    recorder.end('p1', 'ghost', 300, 'completed')
    assert.deepEqual(recorder.spansFor('p1'), [])
  })

  it('不同父会话各自记账', () => {
    const recorder = new TimelineRecorder()
    recorder.start('p1', { runId: 'a', sessionId: 'sa', label: '甲', member: undefined, at: 100 })
    recorder.start('p2', { runId: 'b', sessionId: 'sb', label: '乙', member: undefined, at: 100 })
    assert.equal(recorder.spansFor('p1').length, 1)
    assert.equal(recorder.spansFor('p2').length, 1)
    assert.deepEqual([...recorder.parents()].sort(), ['p1', 'p2'])
  })

  it('没有记录的父会话返回空数组，不抛错', () => {
    assert.deepEqual(new TimelineRecorder().spansFor('nope'), [])
  })

  it('forget 丢掉一个父会话的全部记录', () => {
    const recorder = new TimelineRecorder()
    recorder.start('p1', { runId: 'a', sessionId: 'sa', label: '甲', member: undefined, at: 100 })
    recorder.forget('p1')
    assert.deepEqual(recorder.spansFor('p1'), [])
    assert.deepEqual(recorder.parents(), [])
  })

  it('超过上限后丢新的，保住最早那批——时间轴的基准在开头', () => {
    const recorder = new TimelineRecorder()
    for (let i = 0; i < MAX_SPANS_PER_RUN + 10; i += 1) {
      recorder.start('p1', { runId: `r${i}`, sessionId: `s${i}`, label: '甲', member: undefined, at: i })
    }
    const spans = recorder.spansFor('p1')
    assert.equal(spans.length, MAX_SPANS_PER_RUN)
    assert.equal(spans[0]?.runId, 'r0', '最早那条必须还在')
  })
})

describe('时间轴：布局', () => {
  it('空输入给空输出', () => {
    assert.deepEqual(layoutSpans([], 1000), [])
  })

  it('串行的两条泳道首尾相接，互不重叠', () => {
    const geometry = layoutSpans([
      span({ runId: 'a', observedStart: 0, observedEnd: 500 }),
      span({ runId: 'b', observedStart: 500, observedEnd: 1000 }),
    ], 1000)
    assert.equal(geometry[0]?.offset, 0)
    assert.equal(geometry[0]?.width, 50)
    assert.equal(geometry[1]?.offset, 50)
    assert.equal(geometry[1]?.width, 50)
  })

  it('并行的两条泳道位置重叠——这正是要传达的信息', () => {
    const geometry = layoutSpans([
      span({ runId: 'a', observedStart: 0, observedEnd: 1000 }),
      span({ runId: 'b', observedStart: 200, observedEnd: 800 }),
    ], 1000)
    const [first, second] = geometry
    assert.ok(first !== undefined && second !== undefined)
    assert.ok(first.offset < second.offset + second.width)
    assert.ok(second.offset < first.offset + first.width)
  })

  it('还在跑的泳道画到 now，因此时间轴会随轮询增长', () => {
    const running = span({ runId: 'a', observedStart: 0, observedEnd: undefined })
    const early = layoutSpans([running], 1000)[0]!
    const later = layoutSpans([running], 2000)[0]!
    // 单独一条时它总是占满整根轴，因此看宽度看不出增长——看的是轴本身变长了，
    // 而那体现在与一条已结束泳道的相对关系上。
    const withFinished = layoutSpans([
      span({ runId: 'done', observedStart: 0, observedEnd: 500 }),
      running,
    ], 1000)
    const withFinishedLater = layoutSpans([
      span({ runId: 'done', observedStart: 0, observedEnd: 500 }),
      running,
    ], 2000)
    assert.equal(early.width, 100)
    assert.equal(later.width, 100)
    assert.ok(withFinished[0]!.width > withFinishedLater[0]!.width, '轴变长后已结束那条占比变小')
  })

  it('极短的泳道也有可见宽度——「它跑过而且很快」正是要传达的', () => {
    const geometry = layoutSpans([
      span({ runId: 'long', observedStart: 0, observedEnd: 300_000 }),
      span({ runId: 'blink', observedStart: 100_000, observedEnd: 100_030 }),
    ], 300_000)
    assert.ok(geometry[1]!.width > 0, '不能是 0 宽')
    assert.ok(geometry[1]!.width >= 1, '要有可见宽度')
  })

  it('任何泳道都不超出右边界', () => {
    const geometry = layoutSpans([
      span({ runId: 'long', observedStart: 0, observedEnd: 300_000 }),
      // 最后一瞬才起跑又立刻结束：撑到最小宽度后会越界，必须被推回来。
      span({ runId: 'tail', observedStart: 299_999, observedEnd: 300_000 }),
    ], 300_000)
    for (const geo of geometry) {
      assert.ok(geo.offset >= 0)
      assert.ok(geo.offset + geo.width <= 100 + 1e-9, `越界：${geo.offset} + ${geo.width}`)
    }
  })

  it('全部落在同一毫秒时不除以 0', () => {
    const geometry = layoutSpans([
      span({ runId: 'a', observedStart: 5, observedEnd: 5 }),
      span({ runId: 'b', observedStart: 5, observedEnd: 5 }),
    ], 5)
    for (const geo of geometry) {
      assert.ok(Number.isFinite(geo.offset))
      assert.ok(Number.isFinite(geo.width))
    }
  })
})
