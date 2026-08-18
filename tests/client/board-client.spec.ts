/**
 * client 侧纯逻辑的行为契约：面板开关的订阅语义，以及 Board 客户端的
 * in-flight guard / 失败保留上次快照 / 响应形状校验。这些不碰 DOM，可在
 * node 里直接测——真正的 jsdom + SlotTestRuntime 挂载留给 GUI 验证。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createPanelState } from '../../src/client/panel-state.ts'
import { BoardClient } from '../../src/client/board-client.ts'
import type { FetchLike } from '../../src/client/board-client.ts'
import { BOARD_VERSION } from '../../src/domain/types.ts'

describe('panel-state', () => {
  it('初始关闭，open/close/toggle 生效', () => {
    const panel = createPanelState()
    assert.equal(panel.isOpen(), false)
    panel.open()
    assert.equal(panel.isOpen(), true)
    panel.toggle()
    assert.equal(panel.isOpen(), false)
  })

  it('订阅者在状态变化时收到通知', () => {
    const panel = createPanelState()
    let count = 0
    panel.subscribe(() => { count += 1 })
    panel.open()
    panel.close()
    assert.equal(count, 2)
  })

  it('设成相同值不触发通知', () => {
    const panel = createPanelState()
    let count = 0
    panel.subscribe(() => { count += 1 })
    panel.close() // 本来就是关的
    assert.equal(count, 0)
  })

  it('取消订阅后不再收到通知', () => {
    const panel = createPanelState()
    let count = 0
    const unsubscribe = panel.subscribe(() => { count += 1 })
    panel.open()
    unsubscribe()
    panel.close()
    assert.equal(count, 1)
  })
})

type FetchSpec = { ok: boolean; status: number; body: unknown } | 'throw'

/** 造一个可编排的 fake fetch。用尽后重复最后一条。 */
function fakeFetch(responses: readonly FetchSpec[]): FetchLike {
  let index = 0
  return async () => {
    const spec = responses[Math.min(index, responses.length - 1)]
    index += 1
    if (spec === undefined || spec === 'throw') throw new Error('network down')
    return { ok: spec.ok, status: spec.status, json: async () => spec.body }
  }
}

const boardBody = (issues: unknown[] = []) => ({
  board: { version: BOARD_VERSION, nextNumber: issues.length + 1, issues },
  liveUsage: {},
  sandboxPresets: ['workspace-write'],
  canDispatch: true,
})

describe('BoardClient.refresh', () => {
  it('成功后暴露快照', async () => {
    const client = new BoardClient(fakeFetch([{ ok: true, status: 200, body: boardBody([{ id: 'a' }]) }]))
    const view = await client.refresh()
    assert.equal(view?.board.issues.length, 1)
    assert.equal(client.snapshot?.board.issues.length, 1)
  })

  it('把不属于快照的运行时事实一并读出', async () => {
    const client = new BoardClient(fakeFetch([{ ok: true, status: 200, body: boardBody() }]))
    const view = await client.refresh()
    assert.deepEqual(view?.sandboxPresets, ['workspace-write'])
    assert.equal(view?.canDispatch, true)
  })

  it('时间轴与在跑名单必须透传——这两个字段丢过一次，抽屉的时间轴因此永远不渲染', async () => {
    // 真实事故（浏览器验证抓到的）：类型里声明了、服务端也发了，唯独 readView
    // 没抄这两个字段。组件测试全直接构造 props 不过这里，所以必须由这条接缝钉住。
    const span = {
      runId: 'r1', sessionId: 's1', label: '建 a', member: 'worker_a',
      observedStart: 1, observedEnd: 2, stopReason: 'completed', summary: '建好了。',
    }
    const client = new BoardClient(fakeFetch([{
      ok: true,
      status: 200,
      body: {
        ...boardBody(),
        timelines: { s1: [span] },
        liveMembers: { 'issue-1': ['worker_a'] },
        modelCatalog: [{ value: 'deepseek/deepseek-chat', label: 'DeepSeek Chat（DeepSeek）', provider: 'deepseek', model: 'deepseek-chat' }],
      },
    }]))
    const view = await client.refresh()
    assert.deepEqual(view?.timelines?.s1, [span])
    assert.deepEqual(view?.liveMembers?.['issue-1'], ['worker_a'])
    assert.equal(view?.modelCatalog[0]?.value, 'deepseek/deepseek-chat', '模型清单也要透传——队员的下拉靠它')
  })

  it('请求失败时保留上次成功快照，不清空', async () => {
    const client = new BoardClient(fakeFetch([
      { ok: true, status: 200, body: boardBody([{ id: 'a' }]) },
      { ok: false, status: 500, body: {} },
    ]))
    await client.refresh()
    const after = await client.refresh()
    assert.equal(after?.board.issues.length, 1, '失败刷新应回退到上次快照')
  })

  it('网络抛错时保留上次快照', async () => {
    const client = new BoardClient(fakeFetch([
      { ok: true, status: 200, body: boardBody([{ id: 'a' }]) },
      'throw',
    ]))
    await client.refresh()
    const after = await client.refresh()
    assert.equal(after?.board.issues.length, 1)
  })

  it('响应形状不对时不采信', async () => {
    const client = new BoardClient(fakeFetch([{ ok: true, status: 200, body: { nonsense: true } }]))
    const view = await client.refresh()
    assert.equal(view, undefined)
  })
})

describe('BoardClient 写操作', () => {
  it('创建成功后补一次刷新拿到全量', async () => {
    // POST /issues 只返回 { issue }，客户端随后 GET /board 拿全量。
    const client = new BoardClient(fakeFetch([
      { ok: true, status: 201, body: { issue: { id: 'a' } } },
      { ok: true, status: 200, body: boardBody([{ id: 'a' }]) },
    ]))
    const result = await client.createIssue({ title: 't', workspace: '/w' })
    assert.equal(result.ok, true)
    assert.equal(client.snapshot?.board.issues.length, 1)
  })

  it('写失败返回错误码与消息', async () => {
    const client = new BoardClient(fakeFetch([{ ok: false, status: 409, body: { message: 'illegal' } }]))
    const result = await client.moveIssue('a', { lane: 'running' })
    assert.equal(result.ok, false)
    assert.equal(result.ok ? 0 : result.status, 409)
    assert.equal(result.ok ? '' : result.message, 'illegal')
  })

  it('move 直接采信返回的视图', async () => {
    const client = new BoardClient(fakeFetch([
      { ok: true, status: 200, body: boardBody([{ id: 'a', lane: 'todo' }]) },
    ]))
    const result = await client.moveIssue('a', { lane: 'todo' })
    assert.equal(result.ok, true)
    assert.equal(client.snapshot?.board.issues.length, 1)
  })

  it('派活与取消打到各自的路径上', async () => {
    const paths: string[] = []
    const client = new BoardClient(async (input) => {
      paths.push(input)
      return { ok: true, status: 202, json: async () => boardBody() }
    })
    await client.dispatch('abc')
    await client.cancel('abc')
    assert.ok(paths[0]?.endsWith('/issues/abc/dispatch'), paths[0])
    assert.ok(paths[1]?.endsWith('/issues/abc/cancel'), paths[1])
  })

  it('id 里的特殊字符被转义，不会把路径拆开', async () => {
    const paths: string[] = []
    const client = new BoardClient(async (input) => {
      paths.push(input)
      return { ok: true, status: 200, json: async () => boardBody() }
    })
    await client.deleteIssue('a/b?c')
    assert.ok(paths[0]?.endsWith('/issues/a%2Fb%3Fc'), paths[0])
  })
})
