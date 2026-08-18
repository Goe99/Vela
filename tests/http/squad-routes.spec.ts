/**
 * 小队路由的接缝契约。用一个内存 fake 顶替 SquadStore，因此这里测的是路由的
 * 语义（状态码、id 从哪来、缺失能力时怎么表现），不是磁盘行为——那部分在
 * `domain/squad.spec.ts` 里。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BoardStore } from '../../src/domain/store.ts'
import { handleApi } from '../../src/http/routes.ts'
import type { ApiDeps, SquadPort } from '../../src/http/routes.ts'
import { API_PREFIX } from '../../src/http/contract.ts'
import type { Squad } from '../../src/domain/squad.ts'
import { DEFAULT_MAX_PARALLEL_MEMBERS, validateSquad } from '../../src/domain/squad.ts'
import type { SquadResult } from '../../src/domain/squad-store.ts'

const LINUX = 'linux'

/** 内存版 SquadPort，语义与真实 store 对齐（含校验与重名判定）。 */
function fakeSquads(initial: readonly Squad[] = []): SquadPort & { readonly saved: Map<string, Squad> } {
  const saved = new Map(initial.map(squad => [squad.id, squad]))
  return {
    saved,
    list: async () => [...saved.values()].sort((left, right) => left.id.localeCompare(right.id)),
    read: async (id): Promise<SquadResult<Squad>> => {
      const found = saved.get(id)
      return found === undefined
        ? { ok: false, code: 'not-found', message: `no squad ${id}` }
        : { ok: true, value: found }
    },
    write: async (squad, options): Promise<SquadResult<Squad>> => {
      const invalid = validateSquad(squad, LINUX)
      if (invalid !== undefined) return { ok: false, code: 'invalid', message: invalid }
      if (options?.expectNew === true && saved.has(squad.id)) {
        return { ok: false, code: 'conflict', message: 'duplicate' }
      }
      saved.set(squad.id, squad)
      return { ok: true, value: squad }
    },
    remove: async (id): Promise<SquadResult<undefined>> => {
      if (!saved.has(id)) return { ok: false, code: 'not-found', message: 'missing' }
      saved.delete(id)
      return { ok: true, value: undefined }
    },
  }
}

async function bench(squads?: SquadPort): Promise<{ store: BoardStore; deps: ApiDeps; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'vela-squad-routes-'))
  const store = await BoardStore.open(join(dir, 'board.json'))
  const deps: ApiDeps = {
    now: () => 1,
    newId: () => 'iss1',
    sandboxPresets: () => ['workspace-write', 'danger-full-access'],
    platform: () => LINUX,
    ...(squads === undefined ? {} : { squads }),
  }
  return { store, deps, dir }
}

// 默认用 ASCII 名，好让用例里能写出确定的 id（`vela-backend`）。
// 中文名走散列兜底，单独一条用例盖。
const body = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  title: 'backend',
  instruction: 'you lead.',
  members: [{ name: 'coder', instruction: 'write code', abilities: ['read', 'edit'], backend: 'spawn' }],
  maxParallelMembers: 2,
  ...overrides,
})

describe('小队路由', () => {
  it('GET /squads 列出小队，并带上队长实际收到的完整职责说明', async () => {
    const { store, deps, dir } = await bench(fakeSquads())
    await handleApi(store, deps, { method: 'POST', path: `${API_PREFIX}/squads`, body: body() })
    const response = await handleApi(store, deps, { method: 'GET', path: `${API_PREFIX}/squads` })
    assert.equal(response.status, 200)
    const payload = response.body as { squads: { id: string; resolvedInstruction: string }[] }
    assert.equal(payload.squads.length, 1)
    assert.equal(payload.squads[0]?.id, 'vela-backend')
    assert.ok(payload.squads[0]?.resolvedInstruction.includes('`coder`'), '要含自动追加的队员名册')
    await rm(dir, { recursive: true, force: true })
  })

  it('POST /squads 由显示名推出 id', async () => {
    const { store, deps, dir } = await bench(fakeSquads())
    const response = await handleApi(store, deps, {
      method: 'POST', path: `${API_PREFIX}/squads`, body: body({ title: 'Backend Squad' }),
    })
    assert.equal(response.status, 201)
    assert.equal((response.body as { squad: Squad }).squad.id, 'vela-backend-squad')
    await rm(dir, { recursive: true, force: true })
  })

  it('纯中文名的小队建得出来，且同名会被当成重名', async () => {
    const { store, deps, dir } = await bench(fakeSquads())
    const first = await handleApi(store, deps, {
      method: 'POST', path: `${API_PREFIX}/squads`, body: body({ title: '后端小队' }),
    })
    assert.equal(first.status, 201, '中文名必须能建')
    const id = (first.body as { squad: Squad }).squad.id
    assert.ok(id.startsWith('vela-'), `id 应带前缀，得到 ${id}`)

    const again = await handleApi(store, deps, {
      method: 'POST', path: `${API_PREFIX}/squads`, body: body({ title: '后端小队' }),
    })
    assert.equal(again.status, 409, '同一个中文名必须被认为重名')
    await rm(dir, { recursive: true, force: true })
  })

  it('POST /squads 重名返回 409', async () => {
    const { store, deps, dir } = await bench(fakeSquads())
    await handleApi(store, deps, { method: 'POST', path: `${API_PREFIX}/squads`, body: body() })
    const again = await handleApi(store, deps, { method: 'POST', path: `${API_PREFIX}/squads`, body: body() })
    assert.equal(again.status, 409)
    await rm(dir, { recursive: true, force: true })
  })

  it('PATCH /squads/:id 改名不换 id——否则已经引用它的卡片会指向一个不存在的小队', async () => {
    const squads = fakeSquads()
    const { store, deps, dir } = await bench(squads)
    await handleApi(store, deps, { method: 'POST', path: `${API_PREFIX}/squads`, body: body() })
    const patched = await handleApi(store, deps, {
      method: 'PATCH', path: `${API_PREFIX}/squads/vela-backend`, body: body({ title: 'renamed' }),
    })
    assert.equal(patched.status, 200)
    const squad = (patched.body as { squad: Squad }).squad
    assert.equal(squad.id, 'vela-backend', 'id 必须保持不变')
    assert.equal(squad.title, 'renamed')
    assert.deepEqual([...squads.saved.keys()], ['vela-backend'], '不应留下两份')
    await rm(dir, { recursive: true, force: true })
  })

  it('队员的 model 字段在保存往返中不丢——它在 HTTP 入口被丢过一次', async () => {
    // 真实事故（浏览器验证抓到的）：readSquad 逐个抄队员字段时漏了 model，
    // PATCH 体里的 model 在写盘前就被丢掉，界面上填了模型保存后回来是空的。
    const squads = fakeSquads()
    const { store, deps, dir } = await bench(squads)
    await handleApi(store, deps, { method: 'POST', path: `${API_PREFIX}/squads`, body: body() })
    const patched = await handleApi(store, deps, {
      method: 'PATCH',
      path: `${API_PREFIX}/squads/vela-backend`,
      body: body({
        members: [{ name: 'coder', instruction: 'write code', abilities: ['read', 'edit'], backend: 'spawn', model: 'deepseek-reasoner' }],
      }),
    })
    assert.equal(patched.status, 200)
    const squad = (patched.body as { squad: Squad }).squad
    assert.equal(squad.members[0]?.model, 'deepseek-reasoner', 'model 必须活着走到 store')
    // 再读一次列表，确认它不是只在响应里装了装样子。
    const listed = await handleApi(store, deps, { method: 'GET', path: `${API_PREFIX}/squads` })
    const found = (listed.body as { squads: Squad[] }).squads.find(item => item.id === 'vela-backend')
    assert.equal(found?.members[0]?.model, 'deepseek-reasoner', '列表里也要带着')
    await rm(dir, { recursive: true, force: true })
  })

  it('PATCH 不存在的小队返回 404', async () => {
    const { store, deps, dir } = await bench(fakeSquads())
    const response = await handleApi(store, deps, {
      method: 'PATCH', path: `${API_PREFIX}/squads/vela-nope`, body: body(),
    })
    assert.equal(response.status, 404)
    await rm(dir, { recursive: true, force: true })
  })

  it('DELETE /squads/:id 删掉后不再出现在列表里', async () => {
    const { store, deps, dir } = await bench(fakeSquads())
    await handleApi(store, deps, { method: 'POST', path: `${API_PREFIX}/squads`, body: body() })
    const removed = await handleApi(store, deps, { method: 'DELETE', path: `${API_PREFIX}/squads/vela-backend` })
    assert.equal(removed.status, 204)
    const list = await handleApi(store, deps, { method: 'GET', path: `${API_PREFIX}/squads` })
    assert.deepEqual((list.body as { squads: unknown[] }).squads, [])
    await rm(dir, { recursive: true, force: true })
  })

  it('非法的小队被 400 挡在门外', async () => {
    const { store, deps, dir } = await bench(fakeSquads())
    const cases: [string, Record<string, unknown>][] = [
      ['没名字', body({ title: '   ' })],
      ['队员撞名 subagent', body({ members: [{ name: 'subagent', abilities: ['read'], backend: 'spawn' }] })],
      ['队员一项能力都没勾', body({ members: [{ name: 'coder', abilities: [], backend: 'spawn' }] })],
      ['未知后端', body({ members: [{ name: 'coder', abilities: ['read'], backend: 'telepathy' }] })],
      ['号牌数为 0', body({ maxParallelMembers: 0 })],
    ]
    for (const [label, payload] of cases) {
      const response = await handleApi(store, deps, { method: 'POST', path: `${API_PREFIX}/squads`, body: payload })
      assert.equal(response.status, 400, `${label} 应被拒`)
    }
    await rm(dir, { recursive: true, force: true })
  })

  it('缺省号牌数时用默认值', async () => {
    const { store, deps, dir } = await bench(fakeSquads())
    const response = await handleApi(store, deps, {
      method: 'POST', path: `${API_PREFIX}/squads`, body: body({ maxParallelMembers: undefined }),
    })
    assert.equal((response.body as { squad: Squad }).squad.maxParallelMembers, DEFAULT_MAX_PARALLEL_MEMBERS)
    await rm(dir, { recursive: true, force: true })
  })

  it('没有可写 preset 根时，读是空列表、写是 409——不给一个点了就报错的入口', async () => {
    const { store, deps, dir } = await bench()
    const list = await handleApi(store, deps, { method: 'GET', path: `${API_PREFIX}/squads` })
    assert.equal(list.status, 200)
    assert.equal((list.body as { canManageSquads: boolean }).canManageSquads, false)

    for (const request of [
      { method: 'POST', path: `${API_PREFIX}/squads`, body: body() },
      { method: 'PATCH', path: `${API_PREFIX}/squads/vela-x`, body: body() },
      { method: 'DELETE', path: `${API_PREFIX}/squads/vela-x` },
    ]) {
      const response = await handleApi(store, deps, request)
      assert.equal(response.status, 409, `${request.method} 应被拒`)
    }
    await rm(dir, { recursive: true, force: true })
  })
})

describe('打开配置文件的路由', () => {
  it('缺失该能力时报 409 而不是假装成功', async () => {
    const { store, deps, dir } = await bench(fakeSquads())
    const response = await handleApi(store, deps, {
      method: 'POST', path: `${API_PREFIX}/open-document`, body: { target: 'settings' },
    })
    assert.equal(response.status, 409)
    await rm(dir, { recursive: true, force: true })
  })

  it('未知目标被 400 拒绝', async () => {
    const { store, deps, dir } = await bench(fakeSquads())
    const withPort: ApiDeps = { ...deps, documents: { open: async () => ({ opened: true }) } }
    const response = await handleApi(store, withPort, {
      method: 'POST', path: `${API_PREFIX}/open-document`, body: { target: 'nope' },
    })
    assert.equal(response.status, 400)
    await rm(dir, { recursive: true, force: true })
  })

  it('打不开时回 200 并带上路径——那不是错误，是"没帮你打开，位置在这"', async () => {
    const { store, deps, dir } = await bench(fakeSquads())
    const withPort: ApiDeps = {
      ...deps,
      documents: { open: async () => ({ opened: false, path: '/home/me/settings.yaml' }) },
    }
    const response = await handleApi(store, withPort, {
      method: 'POST', path: `${API_PREFIX}/open-document`, body: { target: 'settings' },
    })
    assert.equal(response.status, 200)
    const payload = response.body as { opened: boolean; path?: string }
    assert.equal(payload.opened, false)
    assert.equal(payload.path, '/home/me/settings.yaml')
    await rm(dir, { recursive: true, force: true })
  })

  it('两个目标都受理', async () => {
    const { store, deps, dir } = await bench(fakeSquads())
    const seen: string[] = []
    const withPort: ApiDeps = {
      ...deps,
      documents: { open: async (target) => { seen.push(target); return { opened: true } } },
    }
    for (const target of ['settings', 'agent-presets']) {
      const response = await handleApi(store, withPort, {
        method: 'POST', path: `${API_PREFIX}/open-document`, body: { target },
      })
      assert.equal(response.status, 200, `${target} 应被受理`)
    }
    assert.deepEqual(seen, ['settings', 'agent-presets'])
    await rm(dir, { recursive: true, force: true })
  })
})

describe('看板视图里的小队', () => {
  it('GET /board 带上小队名单、能否管理的标志与部署平台', async () => {
    const { store, deps, dir } = await bench(fakeSquads())
    await handleApi(store, deps, { method: 'POST', path: `${API_PREFIX}/squads`, body: body() })
    const response = await handleApi(store, deps, { method: 'GET', path: `${API_PREFIX}/board` })
    const payload = response.body as { squads: Squad[]; canManageSquads: boolean; platform: string }
    assert.equal(payload.canManageSquads, true)
    assert.equal(payload.squads.length, 1)
    // 浏览器里没有 process，平台这个事实只能由宿主告知。
    assert.equal(payload.platform, LINUX)
    await rm(dir, { recursive: true, force: true })
  })

  it('回完整视图的写操作里小队名单不为空——否则下拉框会在每次编辑后变空', async () => {
    const { store, deps, dir } = await bench(fakeSquads())
    await handleApi(store, deps, { method: 'POST', path: `${API_PREFIX}/squads`, body: body() })
    await handleApi(store, deps, {
      method: 'POST', path: `${API_PREFIX}/issues`, body: { title: 'card', workspace: '/w' },
    })
    const id = store.snapshot().issues[0]!.id

    for (const request of [
      { method: 'PATCH', path: `${API_PREFIX}/issues/${id}`, body: { title: 'edited' } },
      { method: 'POST', path: `${API_PREFIX}/issues/${id}/move`, body: { lane: 'todo' } },
    ]) {
      const response = await handleApi(store, deps, request)
      const payload = response.body as { squads?: Squad[] }
      assert.equal(payload.squads?.length, 1, `${request.method} ${request.path} 要带完整小队名单`)
    }
    await rm(dir, { recursive: true, force: true })
  })

  it('卡片能把 squad 记进执行配置', async () => {
    const { store, deps, dir } = await bench(fakeSquads())
    const created = await handleApi(store, deps, {
      method: 'POST',
      path: `${API_PREFIX}/issues`,
      body: { title: 'card', workspace: '/w', exec: { squad: 'vela-backend' } },
    })
    assert.equal(created.status, 201)
    assert.equal(store.snapshot().issues[0]?.exec.squad, 'vela-backend')
    await rm(dir, { recursive: true, force: true })
  })

  it('同时给 squad 与 agentPreset 被 400 拒绝——两者作用到同一个旋钮', async () => {
    const { store, deps, dir } = await bench(fakeSquads())
    const created = await handleApi(store, deps, {
      method: 'POST',
      path: `${API_PREFIX}/issues`,
      body: { title: 'card', workspace: '/w', exec: { squad: 'vela-a', agentPreset: 'standard' } },
    })
    assert.equal(created.status, 400)
    await rm(dir, { recursive: true, force: true })
  })
})
