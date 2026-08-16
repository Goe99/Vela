/**
 * 执行器的行为契约（票 07/09/10/11）。
 *
 * 用一个 fake harness 驱动完整派活链路：创建会话、施加权限档位、提交任务、
 * 消费会话事件、结算、自动重试、超时取消。这里不真跑 Agent，但**把 Vela 与
 * harness 之间的全部交互顺序都钉住了**——那正是最容易写错的地方。
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BoardStore } from '../src/domain/store.ts'
import { createIssue } from '../src/domain/board.ts'
import { Runner, buildPrompt, observeSessions } from '../src/runner.ts'
import type { Issue } from '../src/domain/types.ts'
import type {
  ApiProxyLike, PermissionPresetsLike, SessionEventLike, SessionHandle, SessionStoreLike,
} from '../src/dsh.ts'
import type { Squad } from '../src/domain/squad.ts'

/** harness 侧收到的每一次调用，按发生顺序。 */
interface Call { readonly method: string; readonly payload: unknown }

interface Harness {
  readonly runner: Runner
  readonly store: BoardStore
  readonly calls: Call[]
  /** 权限档位的施加记录：[sessionId, presetName]。 */
  readonly applied: [string, string][]
  /** 把一条会话事件推给执行器。 */
  emit(sessionId: string, event: SessionEventLike): void
  /** 触发所有待定计时器（模拟时间流逝）。 */
  fireTimers(): void
  /** 待定计时器数量——用来断言 dispose 后不留计时器。 */
  pendingTimers(): number
}

let dir: string
let harness: Harness

interface HarnessOptions {
  /** create 返回失败。 */
  readonly failCreate?: string
  /** prompt 返回失败。 */
  readonly failPrompt?: string
  /** 部署提供的权限 preset 名字；空数组表示未挂载该服务。 */
  readonly presets?: readonly string[]
  /** permissionPresets.set 抛错。 */
  readonly failApply?: string
  /** 会话不在 store 里（模拟未 attach）。 */
  readonly detached?: boolean
  readonly defaults?: { agentPreset?: string; sandbox?: string; timeoutMs?: number }
  /** 同时在跑的 Run 上限；缺省给一个大到不碍事的值。 */
  readonly maxConcurrentRuns?: number
  /** 可用的小队；缺省表示这个部署没有小队能力。 */
  readonly squads?: readonly Squad[]
}

async function makeHarness(options: HarnessOptions = {}): Promise<Harness> {
  const store = await BoardStore.open(join(dir, 'board.json'))
  const calls: Call[] = []
  const applied: [string, string][] = []
  const sessionIds: string[] = []
  let seq = 0
  let clock = 1000
  const timers = new Map<number, () => void>()
  let nextTimer = 1

  const api: ApiProxyLike = {
    sessions: {
      create: async (request) => {
        calls.push({ method: 'create', payload: request.payload })
        if (options.failCreate !== undefined) {
          return { rpcId: request.rpcId, result: { ok: false, error: { code: options.failCreate, message: 'nope' } } }
        }
        const sessionId = `ses${sessionIds.length + 1}`
        sessionIds.push(sessionId)
        return { rpcId: request.rpcId, result: { ok: true, value: { sessionId } } }
      },
      rename: async (request) => {
        calls.push({ method: 'rename', payload: request.payload })
        return { rpcId: request.rpcId, result: { ok: true, value: { title: 'x', seq: 1 } } }
      },
      prompt: async (request) => {
        calls.push({ method: 'prompt', payload: request.payload })
        if (options.failPrompt !== undefined) {
          return { rpcId: request.rpcId, result: { ok: false, error: { code: options.failPrompt, message: 'nope' } } }
        }
        return { rpcId: request.rpcId, result: { ok: true, value: { accepted: true } } }
      },
      cancel: async (request) => {
        calls.push({ method: 'cancel', payload: request.payload })
        return { rpcId: request.rpcId, result: { ok: true, value: { accepted: true } } }
      },
    },
  }

  const presetNames = options.presets ?? ['workspace-write', 'danger-full-access']
  const presets: PermissionPresetsLike | undefined = presetNames.length === 0 ? undefined : {
    names: presetNames,
    set: (session, name) => {
      if (options.failApply !== undefined) throw new Error(options.failApply)
      applied.push([(session as { header?: { id?: string } }).header?.id ?? '?', name])
    },
  }

  const sessions: SessionStoreLike = {
    get: (id) => (options.detached === true
      ? undefined
      : ({ header: { id } } satisfies SessionHandle)),
  }

  const runner = new Runner({
    store,
    now: () => { clock += 1; return clock },
    newId: () => { seq += 1; return `id${seq}` },
    defaults: options.defaults ?? {},
    maxConcurrentRuns: () => options.maxConcurrentRuns ?? 999,
    apiProxy: () => api,
    permissionPresets: () => presets,
    sessions: () => sessions,
    squads: () => (options.squads === undefined ? undefined : {
      read: async (id) => {
        const found = options.squads!.find(squad => squad.id === id)
        return found === undefined
          ? { ok: false, code: 'not-found' as const, message: `no squad ${id}` }
          : { ok: true as const, value: found }
      },
    }),
    setTimer: (fn) => { const handle = nextTimer++; timers.set(handle, fn); return handle },
    clearTimer: (handle) => { timers.delete(handle as number) },
  })

  return {
    runner,
    store,
    calls,
    applied,
    emit: (sessionId, event) => {
      // 走真实的事件桥，连 header 读取一起测到。
      observeSessions(
        listener => { listener({ header: { id: sessionId } }, event); return () => undefined },
        runner,
      )
    },
    fireTimers: () => {
      for (const [handle, fn] of [...timers]) { timers.delete(handle); fn() }
    },
    pendingTimers: () => timers.size,
  }
}

/** 建一张卡片并返回它。 */
async function card(store: BoardStore, overrides: Partial<Issue> = {}, id = 'iss1'): Promise<Issue> {
  let created: Issue | undefined
  await store.mutate((board) => {
    const result = createIssue(board, {
      title: overrides.title ?? 'ship it',
      workspace: overrides.workspace ?? '/repo',
      ...(overrides.maxAttempts === undefined ? {} : { maxAttempts: overrides.maxAttempts }),
      ...(overrides.exec === undefined ? {} : { exec: overrides.exec }),
      ...(overrides.description === undefined ? {} : { description: overrides.description }),
    }, 1, id)
    if (!result.ok) return undefined
    created = result.value.issue
    return { board: result.value.board, value: undefined }
  })
  if (created === undefined) throw new Error('the card could not be created')
  return created
}

/** 当前快照里的那张卡片。 */
function reread(store: BoardStore, id: string): Issue {
  const issue = store.snapshot().issues.find(candidate => candidate.id === id)
  if (issue === undefined) throw new Error(`issue ${id} vanished`)
  return issue
}

/** 从一个结果里取值，失败即让用例爆掉并带上原因。 */
function must<T>(result: { ok: true; value: T } | { ok: false; message: string }): T {
  if (!result.ok) throw new Error(`expected ok, got: ${result.message}`)
  return result.value
}

/**
 * 等执行器的异步结算落定。事件消费是同步的，但结算要落盘（并可能再
 * 触发一次重试派活），因此让宏任务队列跑完。
 */
async function settled(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
  await new Promise(resolve => setTimeout(resolve, 0))
}

/**
 * 等一个条件成立。重试链里夹着两次 fsync 落盘，固定时长的等待会偶发失败；
 * 等条件则既确定又快（条件一成立就返回）。预算给到几秒：它只在**真的坏了**
 * 时才花完，那时带着说明爆掉而不是默默通过。
 */
async function waitFor(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for: ${label}`)
}

const COMPLETED: SessionEventLike = { seq: 9, type: 'turn/end', data: { reason: { kind: 'completed' } } }
const FAILED: SessionEventLike = {
  seq: 9, type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'boom', message: 'kaput' } } },
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vela-runner-'))
  harness = await makeHarness()
})

afterEach(async () => {
  harness.runner.dispose()
  await rm(dir, { recursive: true, force: true })
})

describe('派活', () => {
  it('创建会话用 Issue 的 workspace 作为工作目录，并以标题命名会话', async () => {
    const issue = await card(harness.store, { title: '补一段安装说明', workspace: '/repo/vela' })
    const result = await harness.runner.dispatch(issue.id)
    assert.ok(result.ok)
    const create = harness.calls.find(call => call.method === 'create')
    assert.deepEqual(create?.payload, { cwd: '/repo/vela' })
    const rename = harness.calls.find(call => call.method === 'rename')
    assert.equal((rename?.payload as { title: string }).title, '补一段安装说明')
  })

  it('提交的任务文本就是标题加描述，不额外注入指令', async () => {
    const issue = await card(harness.store, { title: 'do a thing', description: 'more detail' })
    await harness.runner.dispatch(issue.id)
    const prompt = harness.calls.find(call => call.method === 'prompt')
    assert.deepEqual(prompt?.payload, {
      sessionId: 'ses1',
      mode: 'queue',
      content: [{ type: 'text', text: 'do a thing\n\nmore detail' }],
    })
  })

  it('Issue 自动进 Running，且 Run 绑定了会话 id', async () => {
    const issue = await card(harness.store)
    const started = must(await harness.runner.dispatch(issue.id))
    const after = reread(harness.store, issue.id)
    assert.equal(after.lane, 'running')
    assert.equal(after.runs.length, 1)
    assert.equal(after.runs[0]?.sessionId, started.sessionId)
    assert.equal(after.runs[0]?.status, 'running')
  })

  it('同一个 Issue 不能有两个活 Run', async () => {
    const issue = await card(harness.store)
    await harness.runner.dispatch(issue.id)
    const second = await harness.runner.dispatch(issue.id)
    assert.equal(second.ok, false)
    assert.equal(reread(harness.store, issue.id).runs.length, 1)
  })

  it('并发派活只建一个会话——否则会留下孤儿会话', async () => {
    const issue = await card(harness.store)
    const [a, b] = await Promise.all([
      harness.runner.dispatch(issue.id),
      harness.runner.dispatch(issue.id),
    ])
    assert.equal([a, b].filter(result => result.ok).length, 1)
    assert.equal(harness.calls.filter(call => call.method === 'create').length, 1)
  })

  it('提交任务失败时 Run 立刻结算为 error，卡片不会卡在 Running', async () => {
    harness.runner.dispose()
    harness = await makeHarness({ failPrompt: 'agent-busy' })
    const issue = await card(harness.store)
    const result = await harness.runner.dispatch(issue.id)
    assert.equal(result.ok, false)
    const after = reread(harness.store, issue.id)
    assert.equal(after.lane, 'failed')
    assert.equal(after.runs[0]?.status, 'settled')
    assert.match(after.runs[0]?.failure ?? '', /agent-busy/)
  })

  it('创建会话失败时不记录任何 Run', async () => {
    harness.runner.dispose()
    harness = await makeHarness({ failCreate: 'session-conflict' })
    const issue = await card(harness.store)
    const result = await harness.runner.dispatch(issue.id)
    assert.equal(result.ok, false)
    const after = reread(harness.store, issue.id)
    assert.equal(after.lane, 'backlog')
    assert.equal(after.runs.length, 0)
  })

  it('不存在的 Issue 报 not-found，且不碰 harness', async () => {
    const result = await harness.runner.dispatch('ghost')
    assert.equal(result.ok, false)
    assert.equal(harness.calls.length, 0)
  })
})

describe('权限档位', () => {
  it('指定档位时经 permissionPresets 施加到那个会话上', async () => {
    const issue = await card(harness.store, { exec: { sandbox: 'danger-full-access' } })
    await harness.runner.dispatch(issue.id)
    assert.deepEqual(harness.applied, [['ses1', 'danger-full-access']])
  })

  it('档位在提交任务**之前**施加——否则 Agent 会先跑起来再收紧权限', async () => {
    const issue = await card(harness.store, { exec: { sandbox: 'workspace-write' } })
    await harness.runner.dispatch(issue.id)
    const order = harness.calls.map(call => call.method)
    assert.ok(order.indexOf('prompt') > order.indexOf('create'))
    // applied 在 prompt 之前发生：施加时 calls 里还没有 prompt。
    assert.equal(harness.applied.length, 1)
  })

  it('未指定档位时不施加任何东西，沿用会话创建时钉入的默认', async () => {
    const issue = await card(harness.store)
    await harness.runner.dispatch(issue.id)
    assert.deepEqual(harness.applied, [])
  })

  it('全局默认档位对未覆盖的卡片生效', async () => {
    harness.runner.dispose()
    harness = await makeHarness({ defaults: { sandbox: 'workspace-write' } })
    const issue = await card(harness.store)
    await harness.runner.dispatch(issue.id)
    assert.deepEqual(harness.applied, [['ses1', 'workspace-write']])
  })

  it('未知档位名在建会话前就被拒绝', async () => {
    const issue = await card(harness.store, { exec: { sandbox: 'no-such-preset' } })
    const result = await harness.runner.dispatch(issue.id)
    assert.equal(result.ok, false)
    assert.equal(harness.calls.length, 0)
    assert.equal(reread(harness.store, issue.id).runs.length, 0)
  })

  it('施加失败时 Run 结算为 error，不留一个权限未知的执行', async () => {
    harness.runner.dispose()
    harness = await makeHarness({ failApply: 'sandbox unavailable' })
    const issue = await card(harness.store, { exec: { sandbox: 'workspace-write' } })
    const result = await harness.runner.dispatch(issue.id)
    assert.equal(result.ok, false)
    const after = reread(harness.store, issue.id)
    assert.equal(after.lane, 'failed')
    assert.match(after.runs[0]?.failure ?? '', /sandbox unavailable/)
    // 关键：任务从未被提交，Agent 没有在未知权限下跑过。
    assert.equal(harness.calls.filter(call => call.method === 'prompt').length, 0)
  })
})

describe('结算', () => {
  it('成功只到待验收，**永远**不到 done（ADR-0007 的核心不变量）', async () => {
    const issue = await card(harness.store)
    await harness.runner.dispatch(issue.id)
    harness.emit('ses1', COMPLETED)
    await waitFor(() => reread(harness.store, issue.id).lane === 'review', 'the Run to settle')
    assert.equal(reread(harness.store, issue.id).runs[0]?.outcome, 'completed')
  })

  it('失败进 Failed，失败原因写在 Run 上供卡片直接显示', async () => {
    const issue = await card(harness.store)
    await harness.runner.dispatch(issue.id)
    harness.emit('ses1', FAILED)
    await waitFor(() => reread(harness.store, issue.id).lane === 'failed', 'the Run to settle')
    const after = reread(harness.store, issue.id)
    assert.equal(after.runs[0]?.outcome, 'error')
    assert.equal(after.runs[0]?.failure, 'boom: kaput')
  })

  it('别的会话的事件被忽略', async () => {
    const issue = await card(harness.store)
    await harness.runner.dispatch(issue.id)
    harness.emit('someone-elses-session', COMPLETED)
    await settled()
    assert.equal(reread(harness.store, issue.id).lane, 'running')
  })

  it('重复的结束事件是无操作，不会二次结算', async () => {
    const issue = await card(harness.store)
    await harness.runner.dispatch(issue.id)
    harness.emit('ses1', COMPLETED)
    await waitFor(() => reread(harness.store, issue.id).lane === 'review', 'the Run to settle')
    harness.emit('ses1', FAILED)
    await settled()
    const after = reread(harness.store, issue.id)
    assert.equal(after.lane, 'review')
    assert.equal(after.runs.length, 1)
  })
})

describe('Token 用量', () => {
  it('结束时把累计用量一次性写进 Run', async () => {
    const issue = await card(harness.store)
    await harness.runner.dispatch(issue.id)
    harness.emit('ses1', { seq: 1, type: 'assistant/message', data: { usage: { inputTokens: 10, outputTokens: 4 } } })
    harness.emit('ses1', { seq: 2, type: 'assistant/message', data: { usage: { inputTokens: 5, outputTokens: 2 } } })
    harness.emit('ses1', COMPLETED)
    await waitFor(() => reread(harness.store, issue.id).runs[0]?.usage !== undefined, 'the usage snapshot')
    const usage = reread(harness.store, issue.id).runs[0]?.usage
    assert.equal(usage?.inputTokens, 15)
    assert.equal(usage?.outputTokens, 6)
  })

  it('进行中的用量可实时读出，且**不落盘**', async () => {
    const issue = await card(harness.store)
    await harness.runner.dispatch(issue.id)
    harness.emit('ses1', { seq: 1, type: 'assistant/message', data: { usage: { inputTokens: 7, outputTokens: 1 } } })
    assert.equal(harness.runner.liveUsage(issue.id)?.inputTokens, 7)
    assert.equal(harness.runner.liveUsageByIssue()[issue.id]?.inputTokens, 7)
    // 快照里此刻还没有用量——它只在结束时写一次。
    assert.equal(reread(harness.store, issue.id).runs[0]?.usage, undefined)
  })

  it('一条用量都没报时 Run 上的用量缺失（未知），不是 0', async () => {
    const issue = await card(harness.store)
    await harness.runner.dispatch(issue.id)
    harness.emit('ses1', COMPLETED)
    await waitFor(() => reread(harness.store, issue.id).lane === 'review', 'the Run to settle')
    assert.equal(reread(harness.store, issue.id).runs[0]?.usage, undefined)
  })
})

describe('重试', () => {
  it('默认配置下失败**不会**自动重试——防止这条默认值日后被无声改掉', async () => {
    const issue = await card(harness.store)
    await harness.runner.dispatch(issue.id)
    harness.emit('ses1', FAILED)
    await waitFor(() => reread(harness.store, issue.id).lane === 'failed', 'the Run to settle')
    await settled()
    const after = reread(harness.store, issue.id)
    assert.equal(after.maxAttempts, 0)
    assert.equal(after.runs.length, 1)
    assert.equal(after.lane, 'failed')
  })

  it('maxAttempts 未用尽时失败后自动重新派活，且仍是同一个 Issue', async () => {
    const issue = await card(harness.store, { maxAttempts: 1 })
    await harness.runner.dispatch(issue.id)
    harness.emit('ses1', FAILED)
    await waitFor(() => reread(harness.store, issue.id).runs.length === 2, 'the retry to start')
    const after = reread(harness.store, issue.id)
    assert.equal(after.id, issue.id)
    assert.equal(after.lane, 'running')
  })

  it('用尽后停在 Failed 等 Operator', async () => {
    const issue = await card(harness.store, { maxAttempts: 1 })
    await harness.runner.dispatch(issue.id)
    harness.emit('ses1', FAILED)
    // 等 prompt 发出才说明第二次 Run 已完全就绪（比“快照里有两个 Run”更晚）。
    await waitFor(
      () => harness.calls.filter(call => call.method === 'prompt').length === 2,
      'the retry to be submitted',
    )
    harness.emit('ses2', FAILED)
    await waitFor(() => reread(harness.store, issue.id).lane === 'failed', 'the retry to settle')
    assert.equal(reread(harness.store, issue.id).runs.length, 2)
  })

  it('成功后不重试', async () => {
    const issue = await card(harness.store, { maxAttempts: 3 })
    await harness.runner.dispatch(issue.id)
    harness.emit('ses1', COMPLETED)
    await waitFor(() => reread(harness.store, issue.id).lane === 'review', 'the Run to settle')
    await settled()
    assert.equal(reread(harness.store, issue.id).runs.length, 1)
  })
})

describe('取消与超时', () => {
  it('取消先请求宿主停止，再等真正结束', async () => {
    const issue = await card(harness.store)
    await harness.runner.dispatch(issue.id)
    const result = await harness.runner.cancel(issue.id)
    assert.ok(result.ok)
    assert.deepEqual(harness.calls.at(-1), { method: 'cancel', payload: { sessionId: 'ses1' } })
    // 取消调用返回 ≠ 执行已结束：此刻仍在 Running。
    assert.equal(reread(harness.store, issue.id).lane, 'running')
    harness.emit('ses1', { seq: 9, type: 'turn/end', data: { reason: { kind: 'aborted' } } })
    await waitFor(() => reread(harness.store, issue.id).lane === 'failed', 'the Run to settle')
  })

  it('宽限内等不到结束事件就强制结算，卡片不会永远停在 Running', async () => {
    const issue = await card(harness.store)
    await harness.runner.dispatch(issue.id)
    await harness.runner.cancel(issue.id)
    harness.fireTimers()
    await waitFor(() => reread(harness.store, issue.id).lane === 'failed', 'the forced settle')
    assert.equal(reread(harness.store, issue.id).runs[0]?.status, 'settled')
  })

  it('超时触发取消，且结果与其他失败原因可区分', async () => {
    harness.runner.dispose()
    harness = await makeHarness({ defaults: { timeoutMs: 5000 } })
    const issue = await card(harness.store)
    await harness.runner.dispatch(issue.id)
    harness.fireTimers()
    await waitFor(() => harness.calls.some(call => call.method === 'cancel'), 'the cancel request')
    // DSH 报的是 aborted，但对 Operator 而言真实原因是超时。
    harness.emit('ses1', { seq: 9, type: 'turn/end', data: { reason: { kind: 'aborted' } } })
    await waitFor(() => reread(harness.store, issue.id).lane === 'failed', 'the Run to settle')
    const after = reread(harness.store, issue.id)
    assert.equal(after.runs[0]?.outcome, 'timeout')
    assert.match(after.runs[0]?.failure ?? '', /超时/)
  })

  it('不限时时不安排任何计时器', async () => {
    const issue = await card(harness.store)
    await harness.runner.dispatch(issue.id)
    assert.equal(harness.pendingTimers(), 0)
  })

  it('取消一个没有在途 Run 的 Issue 报 not-found', async () => {
    const issue = await card(harness.store)
    const result = await harness.runner.cancel(issue.id)
    assert.equal(result.ok, false)
  })
})

describe('崩溃恢复', () => {
  it('上次进程留下的 running Run 被结算为 interrupted，不会永远停在 Running', async () => {
    const issue = await card(harness.store)
    await harness.runner.dispatch(issue.id)
    assert.equal(reread(harness.store, issue.id).lane, 'running')

    // 模拟进程重启：同一份快照，一个全新的执行器（无在途状态）。
    harness.runner.dispose()
    const restarted = await makeHarness()
    await restarted.runner.reconcile()
    const after = reread(restarted.store, issue.id)
    assert.equal(after.lane, 'failed')
    assert.equal(after.runs[0]?.outcome, 'interrupted')
    // 用量随进程丢失，因此缺失（未知），不伪造成 0。
    assert.equal(after.runs[0]?.usage, undefined)
    restarted.runner.dispose()
  })

  it('对账不动在途 Run——重复 reconcile 是安全的', async () => {
    const issue = await card(harness.store)
    await harness.runner.dispatch(issue.id)
    await harness.runner.reconcile()
    assert.equal(reread(harness.store, issue.id).lane, 'running')
  })

  it('没有 running Run 时对账什么也不做', async () => {
    await card(harness.store)
    await harness.runner.reconcile()
    assert.equal(harness.store.snapshot().issues[0]?.lane, 'backlog')
  })
})

describe('生命周期', () => {
  it('dispose 后不留计时器，也不再受理派活', async () => {
    harness.runner.dispose()
    harness = await makeHarness({ defaults: { timeoutMs: 5000 } })
    const issue = await card(harness.store)
    await harness.runner.dispatch(issue.id)
    assert.equal(harness.pendingTimers(), 1)
    harness.runner.dispose()
    assert.equal(harness.pendingTimers(), 0)
    const result = await harness.runner.dispatch(issue.id)
    assert.equal(result.ok, false)
  })

  it('未挂载 apiProxy 的部署给出能读的错，而不是静默失败', async () => {
    const store = await BoardStore.open(join(dir, 'other.json'))
    const runner = new Runner({
      store,
      now: () => 1,
      newId: () => 'x',
      defaults: {},
      maxConcurrentRuns: () => 999,
      apiProxy: () => undefined,
      permissionPresets: () => undefined,
      sessions: () => undefined,
      squads: () => undefined,
      setTimer: () => 0,
      clearTimer: () => undefined,
    })
    const issue = await card(store)
    const result = await runner.dispatch(issue.id)
    assert.equal(result.ok, false)
    assert.match(result.ok ? '' : result.message, /apiProxy/)
    runner.dispose()
  })
})

describe('看板级并发上限', () => {
  it('跑满时拒绝派活，且错误里带上当前在跑的数量', async () => {
    harness = await makeHarness({ maxConcurrentRuns: 1 })
    const first = await card(harness.store, {}, 'a')
    const second = await card(harness.store, {}, 'b')
    must(await harness.runner.dispatch(first.id))

    const blocked = await harness.runner.dispatch(second.id)
    assert.equal(blocked.ok, false)
    assert.equal(blocked.ok ? '' : blocked.code, 'conflict')
    assert.match(blocked.ok ? '' : blocked.message, /1 of at most 1/)
  })

  it('被拒的卡不改变所在 Lane，也不多出 Run 记录', async () => {
    harness = await makeHarness({ maxConcurrentRuns: 1 })
    const first = await card(harness.store, {}, 'a')
    const second = await card(harness.store, {}, 'b')
    must(await harness.runner.dispatch(first.id))
    const laneBefore = reread(harness.store, second.id).lane

    await harness.runner.dispatch(second.id)

    const after = reread(harness.store, second.id)
    assert.equal(after.lane, laneBefore, '被拒不能把卡拽进 Running')
    assert.equal(after.runs.length, 0, '被拒不能留下 Run 记录')
  })

  it('有 Run 结束后额度立即释放', async () => {
    harness = await makeHarness({ maxConcurrentRuns: 1 })
    const first = await card(harness.store, {}, 'a')
    const second = await card(harness.store, {}, 'b')
    const run = must(await harness.runner.dispatch(first.id))
    assert.equal((await harness.runner.dispatch(second.id)).ok, false)

    harness.emit(run.sessionId, COMPLETED)
    await settled()

    must(await harness.runner.dispatch(second.id))
  })

  it('同时到达的两次派活只放行到上限为止', async () => {
    harness = await makeHarness({ maxConcurrentRuns: 2 })
    const cards = [
      await card(harness.store, {}, 'a'),
      await card(harness.store, {}, 'b'),
      await card(harness.store, {}, 'c'),
      await card(harness.store, {}, 'd'),
    ]
    // 四张**不同**的卡同时派活。若派活没有全局串行，四边都会读到
    // “目前 0 个在跑”然后全部放行。
    const results = await Promise.all(cards.map(issue => harness.runner.dispatch(issue.id)))
    assert.equal(results.filter(result => result.ok).length, 2, '恰好两个成功')
    assert.equal(harness.runner.runningCount(), 2)
  })

  it('上限为 0 时全面暂停派活，并给出不同于跑满的说法', async () => {
    harness = await makeHarness({ maxConcurrentRuns: 0 })
    const issue = await card(harness.store, {}, 'a')
    const result = await harness.runner.dispatch(issue.id)
    assert.equal(result.ok, false)
    assert.match(result.ok ? '' : result.message, /paused/)
    assert.equal(harness.runner.runningCount(), 0)
  })

  it('上限为非正整数时视为不限', async () => {
    harness = await makeHarness({ maxConcurrentRuns: -1 })
    const first = await card(harness.store, {}, 'a')
    const second = await card(harness.store, {}, 'b')
    must(await harness.runner.dispatch(first.id))
    must(await harness.runner.dispatch(second.id))
    assert.equal(harness.runner.runningCount(), 2)
  })

  it('崩溃恢复后上次遗留的 running 不永久占额', async () => {
    harness = await makeHarness({ maxConcurrentRuns: 1 })
    const issue = await card(harness.store, {}, 'a')
    must(await harness.runner.dispatch(issue.id))
    assert.equal(harness.runner.runningCount(), 1)

    // 新进程：同一份快照里那个 Run 仍标为 running，但没有任何在途状态。
    const fresh = await makeHarness({ maxConcurrentRuns: 1 })
    const reopened = await BoardStore.open(join(dir, 'board.json'))
    const revived = new Runner({
      store: reopened,
      now: () => 9999,
      newId: () => 'z',
      defaults: {},
      maxConcurrentRuns: () => 1,
      apiProxy: () => undefined,
      permissionPresets: () => undefined,
      sessions: () => undefined,
      squads: () => undefined,
      setTimer: () => 0,
      clearTimer: () => undefined,
    })
    await revived.reconcile()
    assert.equal(revived.runningCount(), 0, '遗留的 running 必须被结算掉，否则额度永远占着')
    revived.dispose()
    fresh.runner.dispose()
  })
})

describe('派给小队', () => {
  const squad = (overrides: Partial<Squad> = {}): Squad => ({
    id: overrides.id ?? 'vela-backend',
    title: overrides.title ?? 'backend',
    instruction: overrides.instruction ?? 'you lead.',
    members: overrides.members ?? [
      { name: 'coder', instruction: 'write code', abilities: ['read', 'edit'], backend: 'spawn' },
    ],
    ...(overrides.sandbox === undefined ? {} : { sandbox: overrides.sandbox }),
    maxParallelMembers: overrides.maxParallelMembers ?? 2,
  })

  it('小队被解成 agent preset 名字交给会话创建', async () => {
    harness = await makeHarness({ squads: [squad()] })
    const issue = await card(harness.store, { exec: { squad: 'vela-backend' } })
    must(await harness.runner.dispatch(issue.id))
    const create = harness.calls.find(call => call.method === 'create')
    assert.equal((create?.payload as { agentPreset?: string }).agentPreset, 'vela-backend')
  })

  it('不指定小队时行为与以前完全一致', async () => {
    harness = await makeHarness({ squads: [squad()], defaults: { agentPreset: 'standard' } })
    const issue = await card(harness.store)
    must(await harness.runner.dispatch(issue.id))
    const create = harness.calls.find(call => call.method === 'create')
    assert.equal((create?.payload as { agentPreset?: string }).agentPreset, 'standard')
  })

  it('小队自带的档位生效，且在提交任务**之前**施加', async () => {
    harness = await makeHarness({ squads: [squad({ sandbox: 'danger-full-access' })] })
    const issue = await card(harness.store, { exec: { squad: 'vela-backend' } })
    must(await harness.runner.dispatch(issue.id))

    assert.deepEqual(harness.applied, [['ses1', 'danger-full-access']])
    // 顺序是正确性而非风格：DSH 在委派那一刻快照父会话的沙箱给队员，
    // 档位若晚于第一次委派就对那些队员无效（ADR-0017）。
    const methods = harness.calls.map(call => call.method)
    assert.ok(methods.indexOf('prompt') > methods.indexOf('create'), 'prompt 应在 create 之后')
  })

  it('卡片上的显式档位越过小队的档位——越具体的意图越优先', async () => {
    harness = await makeHarness({ squads: [squad({ sandbox: 'danger-full-access' })] })
    const issue = await card(harness.store, {
      exec: { squad: 'vela-backend', sandbox: 'workspace-write' },
    })
    must(await harness.runner.dispatch(issue.id))
    assert.deepEqual(harness.applied, [['ses1', 'workspace-write']])
  })

  it('小队被删掉后派活报 404 并说清是哪支队，而不是静默失败', async () => {
    harness = await makeHarness({ squads: [] })
    const issue = await card(harness.store, { exec: { squad: 'vela-gone' } })
    const result = await harness.runner.dispatch(issue.id)
    assert.equal(result.ok, false)
    assert.equal(result.ok ? '' : result.code, 'not-found')
    assert.match(result.ok ? '' : result.message, /vela-gone/)
    // 关键：一次会话都不能建——建了就是一个无人指向的孤儿会话。
    assert.equal(harness.calls.filter(call => call.method === 'create').length, 0)
  })

  it('部署没有小队能力时，指定了小队的卡被拒而不是忽略那个字段', async () => {
    harness = await makeHarness()
    const issue = await card(harness.store, { exec: { squad: 'vela-backend' } })
    const result = await harness.runner.dispatch(issue.id)
    assert.equal(result.ok, false)
    assert.equal(harness.calls.filter(call => call.method === 'create').length, 0)
  })

  it('小队的 Run 成功后仍然只到待验收，不直接进 done', async () => {
    harness = await makeHarness({ squads: [squad()] })
    const issue = await card(harness.store, { exec: { squad: 'vela-backend' } })
    const run = must(await harness.runner.dispatch(issue.id))
    harness.emit(run.sessionId, COMPLETED)
    await settled()
    assert.equal(reread(harness.store, issue.id).lane, 'review')
  })
})

describe('buildPrompt', () => {
  it('没有描述时任务就是标题', () => {
    assert.equal(buildPrompt({ title: 'just this', description: '' } as Issue), 'just this')
  })

  it('只有空白的描述不产生尾随空行', () => {
    assert.equal(buildPrompt({ title: 'just this', description: '   \n ' } as Issue), 'just this')
  })
})
