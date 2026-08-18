/**
 * 记忆库落盘的行为契约（票 03 / ADR-0021 / 0022 / 0026）。
 *
 * 这里用**真实临时目录**而不是内存 fake：这一层的价值全在「文件真的出现在
 * 磁盘上、内容能被自己读回来」，把 fs 换成 fake 就把要测的东西测掉了。
 *
 * runner 那一段用最小 fake harness 驱动完整链路（派活 → 消费事件 → 结算 →
 * 落盘），刻意不复用 `runner.spec.ts` 里那个 harness：那份属于派活契约，
 * 这份属于记忆契约，两边关心的注入面不同。
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BoardStore } from '../src/domain/store.ts'
import { createIssue } from '../src/domain/board.ts'
import { Runner, observeSessions } from '../src/runner.ts'
import { MemoryStore } from '../src/memory.ts'
import type { MemoryWriter } from '../src/memory.ts'
import { readRecap, sectionOf } from '../src/domain/okf-recap.ts'
import type { RunFacts } from '../src/domain/okf-recap.ts'
import type { Issue } from '../src/domain/types.ts'
import type {
  ApiProxyLike, PermissionPresetsLike, SessionEventLike, SessionHandle, SessionStoreLike,
} from '../src/dsh.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vela-memory-'))
})

afterEach(async () => {
  // 带重试地删：结算是 detached 的，用例返回后那条写链可能还在落盘，
  // 一次性 rm 会在 Windows 上撞到 ENOTEMPTY。
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
})

const AT = Date.parse('2026-08-17T09:00:00.000Z')

/** 一份最小事实。 */
function facts(overrides: Partial<RunFacts> = {}): RunFacts {
  return {
    issueNumber: 12,
    runSeq: 1,
    sessionId: 'ses1',
    workspace: '/repo',
    title: '给 ordering 补测试',
    outcome: 'completed',
    startedAt: AT,
    endedAt: AT + 5_000,
    files: [],
    commands: [],
    ...overrides,
  }
}

/** 等一个条件成立。结算是 detached 的，落盘因此比事件晚一拍。 */
async function waitFor(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let tries = 0; tries < 200; tries += 1) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`等不到：${what}`)
}

describe('记忆库：路径与落盘', () => {
  it('相对路径直接拒绝，不猜当前目录', () => {
    // 一个 cwd 回落会把 Operator 的记忆散落在进程恰好启动的地方（ADR-0022）。
    assert.throws(() => MemoryStore.open('./memory'), /绝对路径/)
  })

  it('打开时不创建任何目录', async () => {
    const root = join(dir, 'mem')
    MemoryStore.open(root)
    await assert.rejects(readdir(root), /ENOENT/)
  })

  it('落一篇复盘：路径按工作区分目录，文件名带卡号与第几次执行', async () => {
    const store = MemoryStore.open(join(dir, 'mem'))
    const path = await store.landRecap(facts({ runSeq: 3 }), undefined, AT)
    assert.match(path, /^runs\/repo-[0-9a-f]{8}\/12-r3\.md$/)
    assert.ok(await store.readFileAt(path) !== undefined, '文件应当真的在磁盘上')
  })

  it('落盘顺带记一行更新历史', async () => {
    const store = MemoryStore.open(join(dir, 'mem'))
    await store.landRecap(facts(), undefined, AT)
    const history = await store.history()
    assert.equal(history.length, 1)
    assert.match(history[0]!, /落下 `runs\/.+\/12-r1\.md`（第 1 次执行，completed）/)
  })

  it('落盘顺带重算索引：根索引与工作区索引都在', async () => {
    const store = MemoryStore.open(join(dir, 'mem'))
    await store.landRecap(facts(), undefined, AT)
    const root = await store.readFileAt('index.md')
    assert.match(root!, /okf_version: "0\.2"/)
    assert.match(root!, /\/repo/)
    const stored = await store.list()
    const slug = stored[0]!.path.split('/')[1]!
    assert.ok(await store.readFileAt(`runs/${slug}/index.md`) !== undefined, '工作区索引应当存在')
  })

  it('列出来的复盘能被读懂', async () => {
    const store = MemoryStore.open(join(dir, 'mem'))
    await store.landRecap(facts(), { conclusion: '跑通了', did: '补了测试', pitfalls: '无' }, AT)
    const stored = await store.list()
    assert.equal(stored.length, 1)
    assert.equal(stored[0]!.recap?.title, '给 ordering 补测试')
    assert.equal(stored[0]!.recap?.trust, 'unverified')
    assert.equal(stored[0]!.recap?.status, 'draft')
    assert.equal(stored[0]!.recap?.workspace, '/repo')
  })

  it('读不懂的文件带着原因列出来，不从列表里消失', async () => {
    // ADR-0023：一篇读不了的复盘要显示成「这篇读不了」，静默跳过等于丢数据。
    const store = MemoryStore.open(join(dir, 'mem'))
    await store.landRecap(facts(), undefined, AT)
    await mkdir(join(dir, 'mem', 'runs', 'broken-00000000'), { recursive: true })
    await writeFile(join(dir, 'mem', 'runs', 'broken-00000000', '9-r1.md'), '这不是 OKF 文档\n', 'utf8')
    const stored = await store.list()
    assert.equal(stored.length, 2)
    const bad = stored.find(item => item.recap === undefined)
    if (bad === undefined) throw new Error('坏文件应当仍然出现在列表里')
    assert.match(bad.problem!, /第 1 行/)
  })

  it('目录还不存在时列表是空的，而不是报错', async () => {
    assert.deepEqual(await MemoryStore.open(join(dir, 'nothing')).list(), [])
  })

  it('索引不收读不懂的那些，但它们仍留在磁盘上', async () => {
    const store = MemoryStore.open(join(dir, 'mem'))
    await store.landRecap(facts(), undefined, AT)
    await mkdir(join(dir, 'mem', 'runs', 'broken-00000000'), { recursive: true })
    await writeFile(join(dir, 'mem', 'runs', 'broken-00000000', '9-r1.md'), '坏的\n', 'utf8')
    await store.reindex(AT)
    const root = await store.readFileAt('index.md')
    assert.doesNotMatch(root!, /broken-00000000/)
    assert.ok(await store.readFileAt('runs/broken-00000000/9-r1.md') !== undefined)
  })

  it('两篇复盘先后落盘，一篇都不会丢', async () => {
    const store = MemoryStore.open(join(dir, 'mem'))
    await Promise.all([
      store.landRecap(facts({ issueNumber: 1 }), undefined, AT),
      store.landRecap(facts({ issueNumber: 2 }), undefined, AT + 1_000),
    ])
    assert.equal((await store.list()).length, 2)
    assert.equal((await store.history()).length, 2)
  })
})

describe('记忆库：验收与删除', () => {
  it('验收回写人审记录并记一行历史', async () => {
    const store = MemoryStore.open(join(dir, 'mem'))
    const path = await store.landRecap(facts(), undefined, AT)
    assert.equal(await store.verify(path, AT + 60_000), true)
    const recap = readRecap((await store.readFileAt(path))!)
    assert.equal(recap.trust, 'human-reviewed')
    assert.equal(recap.status, 'stable')
    assert.match((await store.history())[0]!, /经 human:operator 验收/)
  })

  it('验收一个不存在的路径给 false，不建文件', async () => {
    const store = MemoryStore.open(join(dir, 'mem'))
    assert.equal(await store.verify('runs/nope/1-r1.md', AT), false)
  })

  it('标废弃只改状态', async () => {
    const store = MemoryStore.open(join(dir, 'mem'))
    const path = await store.landRecap(facts(), undefined, AT)
    await store.deprecate(path, '这张卡被退回后重跑了', AT + 1_000)
    assert.equal(readRecap((await store.readFileAt(path))!).status, 'deprecated')
    assert.match((await store.history())[0]!, /标为废弃/)
  })

  it('删除留痕', async () => {
    const store = MemoryStore.open(join(dir, 'mem'))
    const path = await store.landRecap(facts(), undefined, AT)
    assert.equal(await store.remove(path, AT + 1_000), true)
    assert.equal(await store.readFileAt(path), undefined)
    assert.match((await store.history())[0]!, /被 human:operator 删除/)
    // 删完索引里也不该还留着它。
    assert.doesNotMatch((await store.readFileAt('index.md'))!, /12-r1/)
  })

  it('召回展开一次，引用计数加一', async () => {
    const store = MemoryStore.open(join(dir, 'mem'))
    const path = await store.landRecap(facts(), undefined, AT)
    await store.countUse(path, AT + 1_000)
    assert.equal(readRecap((await store.readFileAt(path))!).usageCount, 1)
  })
})

/** runner 集成用的最小 harness。 */
interface Harness {
  readonly runner: Runner
  readonly store: BoardStore
  readonly prompts: string[]
  /** 执行器记下的警告。 */
  readonly warnings: string[]
  emit(sessionId: string, event: SessionEventLike): void
}

/** 起一个执行器；`memory` 缺省表示没配记忆库。 */
async function makeHarness(memory?: MemoryWriter): Promise<Harness> {
  const store = await BoardStore.open(join(dir, 'board.json'))
  const prompts: string[] = []
  const warnings: string[] = []
  let seq = 0
  let clock = AT
  const api: ApiProxyLike = {
    sessions: {
      create: async request => ({ rpcId: request.rpcId, result: { ok: true, value: { sessionId: 'ses1' } } }),
      rename: async request => ({ rpcId: request.rpcId, result: { ok: true, value: { title: 'x', seq: 1 } } }),
      prompt: async (request) => {
        prompts.push(request.payload.content.map(block => block.text).join(''))
        return { rpcId: request.rpcId, result: { ok: true, value: { accepted: true } } }
      },
      cancel: async request => ({ rpcId: request.rpcId, result: { ok: true, value: { accepted: true } } }),
    },
  }
  const presets: PermissionPresetsLike = { names: ['workspace-write'], set: () => undefined }
  const sessions: SessionStoreLike = { get: id => ({ header: { id } } satisfies SessionHandle) }
  const runner = new Runner({
    store,
    now: () => { clock += 1; return clock },
    newId: () => { seq += 1; return `id${seq}` },
    defaults: {},
    maxConcurrentRuns: () => 999,
    apiProxy: () => api,
    permissionPresets: () => presets,
    sessions: () => sessions,
    squads: () => undefined,
    memory: () => memory,
    setTimer: () => 1,
    clearTimer: () => undefined,
    logger: {
      warn: message => { warnings.push(String(message)) },
      info: () => undefined,
    },
  })
  return {
    runner,
    store,
    prompts,
    warnings,
    emit: (sessionId, event) => {
      observeSessions(
        listener => { listener({ header: { id: sessionId } }, event); return () => undefined },
        runner,
      )
    },
  }
}

/** 建一张卡。 */
async function card(store: BoardStore): Promise<Issue> {
  let created: Issue | undefined
  await store.mutate((board) => {
    const result = createIssue(board, { title: '给 ordering 补测试', workspace: '/repo' }, AT, 'iss1')
    if (!result.ok) return undefined
    created = result.value.issue
    return { board: result.value.board, value: undefined }
  })
  if (created === undefined) throw new Error('建卡失败')
  return created
}

/** 一条成功结束的事件。 */
const COMPLETED: SessionEventLike = { seq: 9, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }

/** 一条报错结束的事件。 */
const FAILED: SessionEventLike = {
  seq: 9,
  type: 'turn/end',
  data: { turn: 1, reason: { kind: 'error', error: { code: 'provider', message: '炸了' } } },
}

/** 造一条带正文的 assistant 消息。 */
function assistantSaid(text: string): SessionEventLike {
  return {
    seq: 2,
    type: 'assistant/message',
    data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } },
  }
}

/** 造一次工具调用。 */
function toolCalled(name: string, args: Record<string, unknown>): SessionEventLike {
  return { seq: 3, type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name, arguments: JSON.stringify(args) } }
}

describe('执行器落复盘', () => {
  it('成功收尾且交付了收尾块，正文进复盘', async () => {
    const memory = MemoryStore.open(join(dir, 'mem'))
    const harness = await makeHarness(memory)
    const issue = await card(harness.store)
    await harness.runner.dispatch(issue.id)
    harness.emit('ses1', assistantSaid([
      '干完了。', '', '```vela-recap', '## 结论', '', '跑通了', '## 做了什么', '', '补了 6 个用例',
      '## 坑与注意', '', 'position 会收敛', '```',
    ].join('\n')))
    harness.emit('ses1', COMPLETED)
    await waitFor(async () => (await memory.list()).length > 0, '复盘落盘')
    const recap = (await memory.list())[0]!.recap!
    assert.equal(sectionOf(recap.body, '## 结论'), '跑通了')
    assert.equal(sectionOf(recap.body, '## 坑与注意'), 'position 会收敛')
  })

  it('成功但没交付收尾块，正文明确标注而不是伪造', async () => {
    const memory = MemoryStore.open(join(dir, 'mem'))
    const harness = await makeHarness(memory)
    const issue = await card(harness.store)
    await harness.runner.dispatch(issue.id)
    harness.emit('ses1', assistantSaid('我做完了，但没按格式写。'))
    harness.emit('ses1', COMPLETED)
    await waitFor(async () => (await memory.list()).length > 0, '复盘落盘')
    const recap = (await memory.list())[0]!.recap!
    assert.match(sectionOf(recap.body, '## 结论'), /没有交付收尾块/)
  })

  it('失败收尾只落客观部分，不拿 Agent 的话当经验', async () => {
    // ADR-0026：失败执行的收尾回复常常只有半句话，拿它当经验会污染召回。
    const memory = MemoryStore.open(join(dir, 'mem'))
    const harness = await makeHarness(memory)
    const issue = await card(harness.store)
    await harness.runner.dispatch(issue.id)
    harness.emit('ses1', assistantSaid('```vela-recap\n## 结论\n\n我觉得挺好\n```'))
    harness.emit('ses1', FAILED)
    await waitFor(async () => (await memory.list()).length > 0, '复盘落盘')
    const recap = (await memory.list())[0]!.recap!
    assert.doesNotMatch(recap.body, /我觉得挺好/)
    assert.match(sectionOf(recap.body, '## 结论'), /报错结束/)
    assert.ok(recap.tags.includes('outcome:error'), `实际标签：${recap.tags.join(' ')}`)
  })

  it('工具足迹被数出来：同一路径读两次算一次重复', async () => {
    const memory = MemoryStore.open(join(dir, 'mem'))
    const harness = await makeHarness(memory)
    const issue = await card(harness.store)
    await harness.runner.dispatch(issue.id)
    harness.emit('ses1', toolCalled('read', { file_path: '/repo/a.ts' }))
    harness.emit('ses1', toolCalled('read', { file_path: '/repo/a.ts' }))
    harness.emit('ses1', toolCalled('read', { file_path: '/repo/b.ts' }))
    harness.emit('ses1', toolCalled('write', { file_path: '/repo/b.ts' }))
    harness.emit('ses1', toolCalled('bash', { command: 'pnpm test' }))
    harness.emit('ses1', COMPLETED)
    await waitFor(async () => (await memory.list()).length > 0, '复盘落盘')
    const text = (await memory.readFileAt((await memory.list())[0]!.path))!
    assert.match(text, /repeated_reads: 1/)
    assert.match(text, /files_touched: 2/)
    assert.match(text, /commands_run: 1/)
    assert.match(text, /`\/repo\/a\.ts` 读 2 次、写 0 次/)
    assert.match(text, /`\/repo\/b\.ts` 读 1 次、写 1 次/)
    assert.match(text, /pnpm test/)
  })

  it('没配记忆库时一个文件都不写，派活文本也一字不差', async () => {
    const harness = await makeHarness(undefined)
    const issue = await card(harness.store)
    await harness.runner.dispatch(issue.id)
    harness.emit('ses1', COMPLETED)
    await waitFor(() => harness.store.snapshot().issues[0]?.runs[0]?.status === 'settled', '结算')
    assert.deepEqual((await readdir(dir)).filter(name => name === 'mem'), [])
    assert.equal(harness.prompts[0], '给 ordering 补测试')
    assert.doesNotMatch(harness.prompts[0]!, /收尾要求/)
  })

  it('配了记忆库时派活文本多出收尾要求，且带明确标题', async () => {
    // ADR-0027：守的不是「不注入」，而是不偷偷注入。
    const harness = await makeHarness(MemoryStore.open(join(dir, 'mem')))
    const issue = await card(harness.store)
    await harness.runner.dispatch(issue.id)
    assert.match(harness.prompts[0]!, /## 收尾要求/)
    assert.match(harness.prompts[0]!, /vela-recap/)
    assert.match(harness.prompts[0]!, /## 本次的任务/)
    assert.match(harness.prompts[0]!, /不由你声明/)
  })

  it('落盘失败只记一句，不影响 Run 结算', async () => {
    // 一张卡的复盘没写成，不能把整个 dsh 拖下水（ADR-0021）。
    const broken: MemoryWriter = { landRecap: async () => { throw new Error('盘满了') } }
    const harness = await makeHarness(broken)
    const issue = await card(harness.store)
    await harness.runner.dispatch(issue.id)
    harness.emit('ses1', COMPLETED)
    await waitFor(() => harness.warnings.length > 0, '警告')
    const run = harness.store.snapshot().issues[0]!.runs[0]!
    assert.equal(run.status, 'settled')
    assert.equal(run.outcome, 'completed')
    assert.match(harness.warnings.join('\n'), /盘满了/)
  })
})

describe('失败与中断只落客观复盘', () => {
  /** 跑一次到指定结局，返回落下的那篇。 */
  async function landedWith(end: SessionEventLike): Promise<{ body: string; text: string; tags: readonly string[] }> {
    const memory = MemoryStore.open(join(dir, 'mem'))
    const harness = await makeHarness(memory)
    const issue = await card(harness.store)
    await harness.runner.dispatch(issue.id)
    harness.emit('ses1', end)
    await waitFor(async () => (await memory.list()).length > 0, '复盘落盘')
    const stored = (await memory.list())[0]!
    return {
      body: stored.recap!.body,
      text: (await memory.readFileAt(stored.path))!,
      tags: stored.recap!.tags,
    }
  }

  it('取消标注成取消，而不是笼统的失败', async () => {
    const landed = await landedWith({
      seq: 9, type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted' } },
    })
    assert.match(sectionOf(landed.body, '## 结论'), /被取消/)
    assert.ok(landed.tags.includes('outcome:aborted'))
  })

  it('撞到 token 上限也有自己的说法', async () => {
    const landed = await landedWith({
      seq: 9, type: 'turn/end', data: { turn: 1, reason: { kind: 'max-tokens' } },
    })
    assert.match(sectionOf(landed.body, '## 结论'), /token 上限/)
  })

  it('不认识的结束原因归为报错，不会静默当成成功', async () => {
    // 把未知当成功是最坏的失败模式（outcome.ts 的同一条纪律）。
    const landed = await landedWith({
      seq: 9, type: 'turn/end', data: { turn: 1, reason: { kind: '天知道' } },
    })
    assert.ok(landed.tags.includes('outcome:error'), `实际标签：${landed.tags.join(' ')}`)
  })

  it('用量缺失时头部不写 0', async () => {
    // 本次执行一条 assistant/message 也没有，因此用量未知。
    const landed = await landedWith(FAILED)
    assert.doesNotMatch(landed.text, /input_tokens/)
    assert.match(landed.text, /用量：未知/)
  })

  it('上一个进程留下的在跑 Run：对账时也落一篇客观复盘', async () => {
    // 对账路径绕开了结算，很容易漏掉——而「这张卡跑过一次、结果未知」
    // 正是 Operator 最想在卡上看到的事实之一。
    const memory = MemoryStore.open(join(dir, 'mem'))
    const first = await makeHarness(memory)
    const issue = await card(first.store)
    await first.runner.dispatch(issue.id)
    // 不发 turn/end，直接当作进程死了：快照里留下一条 running。
    assert.equal(first.store.snapshot().issues[0]!.runs[0]!.status, 'running')
    first.runner.dispose()

    // 新进程：同一份快照，全新的执行器。
    const second = await makeHarness(memory)
    await second.runner.reconcile()
    const stored = await memory.list()
    assert.equal(stored.length, 1)
    assert.ok(stored[0]!.recap!.tags.includes('outcome:interrupted'))
    assert.match(sectionOf(stored[0]!.recap!.body, '## 结论'), /结果未知/)
    // 足迹是空的而不是伪造的：计数只活在上一个进程的内存里。
    const text = (await memory.readFileAt(stored[0]!.path))!
    assert.match(text, /files_touched: 0/)
    assert.doesNotMatch(text, /input_tokens/)
  })

  it('对账时没配记忆库也不报错', async () => {
    const first = await makeHarness(undefined)
    const issue = await card(first.store)
    await first.runner.dispatch(issue.id)
    first.runner.dispose()
    const second = await makeHarness(undefined)
    await second.runner.reconcile()
    assert.equal(second.store.snapshot().issues[0]!.runs[0]!.outcome, 'interrupted')
  })
})
