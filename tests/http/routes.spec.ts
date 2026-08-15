/**
 * HTTP 面（主接缝）的行为契约。直接驱动 handleApi——它是纯
 * request → response，配一个真实临时目录的 store，不起 web server。
 * 覆盖 spec 里定给这个接缝的清单：CRUD、状态机迁移、错误码、并发。
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BoardStore } from '../../src/domain/store.ts'
import { handleApi, API_PREFIX } from '../../src/http/routes.ts'
import type { ApiDeps, ApiRequest, ApiResponse } from '../../src/http/routes.ts'
import type { Board } from '../../src/domain/types.ts'

let dir: string
let store: BoardStore
let clock: number
let seq: number
let deps: ApiDeps

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vela-api-'))
  store = await BoardStore.open(join(dir, 'board.json'))
  clock = 1000
  seq = 0
  deps = {
    now: () => { clock += 1; return clock },
    newId: () => { seq += 1; return `i${seq}` },
    sandboxPresets: () => ['workspace-write', 'danger-full-access'],
  }
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function req(method: string, path: string, body?: unknown): ApiRequest {
  return { method, path: `${API_PREFIX}${path}`, ...(body === undefined ? {} : { body }) }
}

/** 建一张卡片，返回它的 id。 */
async function createCard(title = 'card', workspace = '/w'): Promise<string> {
  const response = await handleApi(store, deps, req('POST', '/issues', { title, workspace }))
  assert.equal(response.status, 201)
  return (response.body as { issue: { id: string } }).issue.id
}

function board(response: ApiResponse): Board {
  return (response.body as { board: Board }).board
}

describe('GET /board', () => {
  it('空 Board 返回空 issues 数组', async () => {
    const response = await handleApi(store, deps, req('GET', '/board'))
    assert.equal(response.status, 200)
    assert.deepEqual(board(response).issues, [])
  })
})

describe('POST /issues', () => {
  it('创建成功返回 201 与新卡片', async () => {
    const response = await handleApi(store, deps, req('POST', '/issues', { title: 'hello', workspace: '/repo' }))
    assert.equal(response.status, 201)
    const issue = (response.body as { issue: { title: string; lane: string } }).issue
    assert.equal(issue.title, 'hello')
    assert.equal(issue.lane, 'backlog')
  })

  it('缺 title 报 400', async () => {
    const response = await handleApi(store, deps, req('POST', '/issues', { workspace: '/w' }))
    assert.equal(response.status, 400)
  })

  it('body 不是对象报 400', async () => {
    const response = await handleApi(store, deps, req('POST', '/issues', 'nope'))
    assert.equal(response.status, 400)
  })

  it('未知优先级报 400', async () => {
    const response = await handleApi(store, deps, req('POST', '/issues', { title: 't', workspace: '/w', priority: 'critical' }))
    assert.equal(response.status, 400)
  })

  it('创建后重开 store 仍在——真的落了盘', async () => {
    await createCard('persisted')
    const reopened = await BoardStore.open(store.path)
    assert.equal(reopened.snapshot().issues[0]?.title, 'persisted')
  })
})

describe('PATCH /issues/:id', () => {
  it('改标题返回 200', async () => {
    const id = await createCard()
    const response = await handleApi(store, deps, req('PATCH', `/issues/${id}`, { title: 'renamed' }))
    assert.equal(response.status, 200)
    assert.equal(board(response).issues[0]!.title, 'renamed')
  })

  it('改不存在的卡片报 404', async () => {
    const response = await handleApi(store, deps, req('PATCH', '/issues/ghost', { title: 'x' }))
    assert.equal(response.status, 404)
  })
})

describe('DELETE /issues/:id', () => {
  it('删除返回 200 且卡片消失', async () => {
    const id = await createCard()
    const response = await handleApi(store, deps, req('DELETE', `/issues/${id}`))
    assert.equal(response.status, 200)
    assert.equal(board(response).issues.length, 0)
  })

  it('删不存在的卡片报 404', async () => {
    const response = await handleApi(store, deps, req('DELETE', '/issues/ghost'))
    assert.equal(response.status, 404)
  })
})

describe('POST /issues/:id/move', () => {
  it('合法迁移返回 200', async () => {
    const id = await createCard()
    const response = await handleApi(store, deps, req('POST', `/issues/${id}/move`, { lane: 'todo' }))
    assert.equal(response.status, 200)
    assert.equal(board(response).issues[0]!.lane, 'todo')
  })

  it('非法迁移报 409，而不是接受后回滚', async () => {
    const id = await createCard()
    const response = await handleApi(store, deps, req('POST', `/issues/${id}/move`, { lane: 'running' }))
    assert.equal(response.status, 409)
    // 卡片仍在 backlog——服务端没有接受这次非法迁移。
    const after = await handleApi(store, deps, req('GET', '/board'))
    assert.equal(board(after).issues[0]!.lane, 'backlog')
  })

  it('缺 lane 报 400', async () => {
    const id = await createCard()
    const response = await handleApi(store, deps, req('POST', `/issues/${id}/move`, {}))
    assert.equal(response.status, 400)
  })
})

describe('POST /issues/:id/gate', () => {
  it('不在 review 的卡片被判定报 409', async () => {
    const id = await createCard()
    const response = await handleApi(store, deps, req('POST', `/issues/${id}/gate`, { verdict: 'accept' }))
    assert.equal(response.status, 409)
  })

  it('verdict 非法报 400', async () => {
    const id = await createCard()
    const response = await handleApi(store, deps, req('POST', `/issues/${id}/gate`, { verdict: 'maybe' }))
    assert.equal(response.status, 400)
  })
})

describe('路由未命中', () => {
  it('未知路径报 404', async () => {
    const response = await handleApi(store, deps, req('GET', '/nonsense'))
    assert.equal(response.status, 404)
  })

  it('前缀外的路径报 404', async () => {
    const response = await handleApi(store, deps, { method: 'GET', path: '/somewhere/else' })
    assert.equal(response.status, 404)
  })

  it('畸形百分号编码报 400 而不是抛出未处理异常', async () => {
    const response = await handleApi(store, deps, { method: 'GET', path: `${API_PREFIX}/issues/%foo` })
    assert.equal(response.status, 400)
  })
})

describe('并发写入经同一条串行链', () => {
  it('十个并发建卡请求全部保留', async () => {
    await Promise.all(Array.from({ length: 10 }, (_, i) =>
      handleApi(store, deps, req('POST', '/issues', { title: `c${i}`, workspace: '/w' }))))
    const response = await handleApi(store, deps, req('GET', '/board'))
    assert.equal(board(response).issues.length, 10)
  })
})
