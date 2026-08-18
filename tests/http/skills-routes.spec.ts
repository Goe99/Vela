/**
 * 技能广场路由（GET /skills）的接缝契约：端口在就透传清单，
 * 不在就明确告知「没开」，而不是报错。
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BoardStore } from '../../src/domain/store.ts'
import { handleApi, API_PREFIX } from '../../src/http/routes.ts'
import type { ApiDeps } from '../../src/http/routes.ts'
import type { InstalledSkill } from '../../src/domain/skills.ts'

let dir: string
let store: BoardStore

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vela-skills-api-'))
  store = await BoardStore.open(join(dir, 'board.json'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function deps(extra: Partial<ApiDeps> = {}): ApiDeps {
  return {
    now: () => 1,
    newId: () => 'i1',
    sandboxPresets: () => [],
    platform: () => 'linux',
    ...extra,
  }
}

const sample: InstalledSkill = {
  name: 'asu',
  description: '简历酥化',
  userOnly: false,
  source: 'agents',
  sourcePath: '/home/x/.agents/skills/asu/SKILL.md',
  effective: true,
}

describe('GET /skills', () => {
  it('端口在就透传技能清单', async () => {
    const response = await handleApi(store, deps({
      skills: { list: async () => [sample] },
    }), { method: 'GET', path: `${API_PREFIX}/skills` })
    assert.equal(response.status, 200)
    const body = response.body as { ok: boolean; available: boolean; skills: readonly InstalledSkill[] }
    assert.equal(body.ok, true)
    assert.equal(body.available, true)
    assert.deepEqual(body.skills, [sample])
  })

  it('端口不在 = 这个部署没开技能页：available 为假、清单为空，不是错误', async () => {
    const response = await handleApi(store, deps(), { method: 'GET', path: `${API_PREFIX}/skills` })
    assert.equal(response.status, 200)
    const body = response.body as { available: boolean; skills: readonly unknown[] }
    assert.equal(body.available, false)
    assert.deepEqual(body.skills, [])
  })

  it('每次请求都现问一次端口——不缓存（目录随时可能被人手改）', async () => {
    let calls = 0
    const port = {
      list: async () => {
        calls += 1
        return calls === 1 ? [sample] : []
      },
    }
    const own = deps({ skills: port })
    const first = await handleApi(store, own, { method: 'GET', path: `${API_PREFIX}/skills` })
    const second = await handleApi(store, own, { method: 'GET', path: `${API_PREFIX}/skills` })
    assert.equal(calls, 2)
    assert.equal((first.body as { skills: unknown[] }).skills.length, 1)
    assert.equal((second.body as { skills: unknown[] }).skills.length, 0)
  })
})
