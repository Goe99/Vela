/**
 * 新增路由的接缝契约：派活、取消、批量建卡、执行配置覆盖，以及 Board 视图里
 * 那三项不属于快照的运行时事实。
 *
 * 派活用一个 fake 执行器驱动——HTTP 层只靠窄接口认识执行器，因此这里能把全部
 * 路由与错误码测到，不需要真的 harness。真实的派活链路由 runner.spec.ts 覆盖。
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BoardStore } from '../../src/domain/store.ts'
import { handleApi, API_PREFIX } from '../../src/http/routes.ts'
import type { ApiDeps, ApiRequest, ApiResponse, DispatchPort } from '../../src/http/routes.ts'
import type { Board, TokenUsage } from '../../src/domain/types.ts'

let dir: string
let store: BoardStore
let deps: ApiDeps
let dispatched: string[]
let cancelled: string[]
let seq: number
let clock: number

/** 一个只记账的执行器；派活行为本身由 runner.spec.ts 覆盖。 */
function fakeDispatcher(options: { failWith?: string; live?: Record<string, TokenUsage> } = {}): DispatchPort {
  return {
    dispatch: async (id) => {
      dispatched.push(id)
      if (options.failWith !== undefined) {
        return { ok: false, code: 'conflict', message: options.failWith }
      }
      return { ok: true, value: { sessionId: `ses-${id}` } }
    },
    cancel: async (id) => {
      cancelled.push(id)
      return { ok: true, value: { sessionId: `ses-${id}` } }
    },
    liveUsageByIssue: () => options.live ?? {},
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vela-routes2-'))
  store = await BoardStore.open(join(dir, 'board.json'))
  dispatched = []
  cancelled = []
  seq = 0
  clock = 1000
  deps = {
    now: () => { clock += 1; return clock },
    newId: () => { seq += 1; return `i${seq}` },
    sandboxPresets: () => ['workspace-write', 'danger-full-access'],
    platform: () => 'linux',
    dispatcher: fakeDispatcher(),
  }
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function req(method: string, path: string, body?: unknown): ApiRequest {
  return { method, path: `${API_PREFIX}${path}`, ...(body === undefined ? {} : { body }) }
}

/**
 * 一套不带执行器的依赖（模拟未挂载 apiProxy 的部署）。必须是**没有**
 * dispatcher 这个键而不是它为 undefined——后者在 exactOptionalPropertyTypes
 * 下不合法，而那条约束正是我们想要的。
 */
function withoutDispatcher(): ApiDeps {
  return {
    now: deps.now,
    newId: deps.newId,
    sandboxPresets: deps.sandboxPresets,
    platform: deps.platform,
  }
}

async function call(method: string, path: string, body?: unknown): Promise<ApiResponse> {
  return handleApi(store, deps, req(method, path, body))
}

async function createCard(title = 'card', workspace = '/w'): Promise<string> {
  const response = await call('POST', '/issues', { title, workspace })
  assert.equal(response.status, 201)
  return (response.body as { issue: { id: string } }).issue.id
}

function board(response: ApiResponse): Board {
  return (response.body as { board: Board }).board
}

describe('GET /board 的运行时事实', () => {
  it('带上部署提供的档位表与派活能力', async () => {
    const response = await call('GET', '/board')
    const body = response.body as Record<string, unknown>
    assert.deepEqual(body.sandboxPresets, ['workspace-write', 'danger-full-access'])
    assert.equal(body.canDispatch, true)
  })

  it('没有执行器时 canDispatch 为 false，实时用量为空', async () => {
    deps = withoutDispatcher()
    const body = (await call('GET', '/board')).body as Record<string, unknown>
    assert.equal(body.canDispatch, false)
    assert.deepEqual(body.liveUsage, {})
  })

  it('实时用量按 Issue 索引给出', async () => {
    const usage: TokenUsage = {
      inputTokens: 5, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
    }
    deps = { ...deps, dispatcher: fakeDispatcher({ live: { abc: usage } }) }
    const body = (await call('GET', '/board')).body as { liveUsage: Record<string, TokenUsage> }
    assert.equal(body.liveUsage.abc?.inputTokens, 5)
  })
})

describe('POST /issues/:id/dispatch', () => {
  it('把派活转给执行器并回 202 带会话 id', async () => {
    const id = await createCard()
    const response = await call('POST', `/issues/${id}/dispatch`)
    assert.equal(response.status, 202)
    assert.deepEqual(dispatched, [id])
    assert.equal((response.body as { sessionId: string }).sessionId, `ses-${id}`)
  })

  it('执行器拒绝时把原因与状态码透出', async () => {
    deps = { ...deps, dispatcher: fakeDispatcher({ failWith: 'already running' }) }
    const id = await createCard()
    const response = await call('POST', `/issues/${id}/dispatch`)
    assert.equal(response.status, 409)
    assert.equal((response.body as { message: string }).message, 'already running')
  })

  it('部署不能派活时报 409 且说明原因，而不是 404 让人以为路径写错', async () => {
    const id = await createCard()
    deps = withoutDispatcher()
    const response = await call('POST', `/issues/${id}/dispatch`)
    assert.equal(response.status, 409)
    assert.match((response.body as { message: string }).message, /apiProxy/)
  })
})

describe('POST /issues/:id/cancel', () => {
  it('转给执行器并回 202', async () => {
    const id = await createCard()
    const response = await call('POST', `/issues/${id}/cancel`)
    assert.equal(response.status, 202)
    assert.deepEqual(cancelled, [id])
  })

  it('部署不能派活时同样报 409', async () => {
    const id = await createCard()
    deps = withoutDispatcher()
    assert.equal((await call('POST', `/issues/${id}/cancel`)).status, 409)
  })
})

describe('POST /issues/batch', () => {
  it('一次落一批卡片，全都进 Backlog', async () => {
    const response = await call('POST', '/issues/batch', {
      workspace: '/repo',
      items: ['第一件', '第二件', '第三件'],
    })
    assert.equal(response.status, 201)
    const issues = board(response).issues
    assert.equal(issues.length, 3)
    assert.ok(issues.every(issue => issue.lane === 'backlog'))
    assert.deepEqual(issues.map(issue => issue.title), ['第一件', '第二件', '第三件'])
  })

  it('批内保持给出的次序', async () => {
    const response = await call('POST', '/issues/batch', { workspace: '/repo', items: ['a', 'b'] })
    const issues = [...board(response).issues].sort((left, right) => left.position - right.position)
    assert.deepEqual(issues.map(issue => issue.title), ['a', 'b'])
  })

  it('也接受 { title } 形式的条目', async () => {
    const response = await call('POST', '/issues/batch', {
      workspace: '/repo',
      items: [{ title: 'a' }, { title: 'b' }],
    })
    assert.equal(response.status, 201)
    assert.equal(board(response).issues.length, 2)
  })

  it('有一条标题为空则整批拒绝——不留下半批卡片', async () => {
    const response = await call('POST', '/issues/batch', { workspace: '/repo', items: ['ok', '  '] })
    assert.equal(response.status, 400)
    assert.equal(store.snapshot().issues.length, 0)
  })

  it('缺 workspace、空批次、非数组都报 400', async () => {
    assert.equal((await call('POST', '/issues/batch', { items: ['a'] })).status, 400)
    assert.equal((await call('POST', '/issues/batch', { workspace: '/w', items: [] })).status, 400)
    assert.equal((await call('POST', '/issues/batch', { workspace: '/w', items: 'nope' })).status, 400)
  })
})

describe('执行配置覆盖', () => {
  it('建卡时可带覆盖，并被存下来', async () => {
    const response = await call('POST', '/issues', {
      title: 'careful work',
      workspace: '/w',
      exec: { sandbox: 'danger-full-access', timeoutMs: 60000 },
    })
    assert.equal(response.status, 201)
    const issue = store.snapshot().issues[0]
    assert.equal(issue?.exec.sandbox, 'danger-full-access')
    assert.equal(issue?.exec.timeoutMs, 60000)
  })

  it('未知档位名在建卡时就被拒绝', async () => {
    const response = await call('POST', '/issues', {
      title: 'x', workspace: '/w', exec: { sandbox: 'not-a-preset' },
    })
    assert.equal(response.status, 400)
    assert.match((response.body as { message: string }).message, /unknown sandbox preset/)
  })

  it('PATCH 可以设置覆盖', async () => {
    const id = await createCard()
    const response = await call('PATCH', `/issues/${id}`, { exec: { sandbox: 'workspace-write' } })
    assert.equal(response.status, 200)
    assert.equal(store.snapshot().issues[0]?.exec.sandbox, 'workspace-write')
  })

  it('显式的 null 清除覆盖，回落到全局默认', async () => {
    const id = await createCard()
    await call('PATCH', `/issues/${id}`, { exec: { sandbox: 'workspace-write', timeoutMs: 5000 } })
    await call('PATCH', `/issues/${id}`, { exec: { sandbox: null, timeoutMs: null } })
    const issue = store.snapshot().issues[0]
    assert.equal(issue?.exec.sandbox, undefined)
    assert.equal(issue?.exec.timeoutMs, undefined)
  })

  it('exec 不是对象时报 400', async () => {
    const id = await createCard()
    assert.equal((await call('PATCH', `/issues/${id}`, { exec: 'nope' })).status, 400)
    assert.equal((await call('PATCH', `/issues/${id}`, { exec: [] })).status, 400)
  })

  it('负数超时被拒绝', async () => {
    const id = await createCard()
    const response = await call('PATCH', `/issues/${id}`, { exec: { timeoutMs: -1 } })
    assert.equal(response.status, 400)
  })

  it('部署一个档位都不提供时拒绝设置档位', async () => {
    deps = { ...deps, sandboxPresets: () => [] }
    const response = await call('POST', '/issues', {
      title: 'x', workspace: '/w', exec: { sandbox: 'workspace-write' },
    })
    assert.equal(response.status, 400)
    assert.match((response.body as { message: string }).message, /no permission presets/)
  })
})
