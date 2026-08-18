/**
 * 号牌层与 DSH 之间那薄薄一层包装（ADR-0018）。
 *
 * 这个文件盯的是三件容易悄悄写错、而且写错了只在真实派活时才暴露的事：
 *
 * 1. **能力标记与 `inheritsParentContext` 必须逐字转发。** 服务层拿它们做校验
 *    （比如「这个后端支不支持工具白名单」），模型层拿它们生成措辞。抄错一个字，
 *    行为会偏离而不是报错。
 * 2. **每一条离开 `start()` 的路都要还牌。** 成功、起跑失败、结果 reject，三条
 *    都得还。漏一条就永久缩小那支队的并发能力，症状是「越用越慢」。
 * 3. **`prepareContinuable` 的有无必须与被包者一致。** DSH 靠属性的存在与否判断
 *    「这个后端支不支持可继续子代理」，不是靠返回值。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SlotPool } from '../src/domain/slots.ts'
import {
  VELA_PROVIDER_PREFIX, installSlottedProviders, slottedProvider, slottedProvidersFor,
} from '../src/squad-provider.ts'
import type {
  SlottedProviderDeps, SubagentProviderLike, SubagentRunLike, SubagentStartRequestLike,
  SubagentsServiceLike,
} from '../src/squad-provider.ts'

/** 一个不做超时对账的池：这些测试关心的是转发与还牌，不是对账。 */
function pool(): SlotPool {
  return new SlotPool({ setTimer: () => 0, clearTimer: () => {}, maxHoldMs: 0 })
}

/** 一个可以手动结束的假原生 provider。 */
function fakeInner(overrides: Partial<SubagentProviderLike> = {}) {
  let settleResult: (() => void) | undefined
  let failResult: ((error: Error) => void) | undefined
  const starts: SubagentStartRequestLike[] = []
  const provider: SubagentProviderLike = {
    name: overrides.name ?? 'spawn',
    capabilities: overrides.capabilities ?? { toolFilter: true, persona: true, depthLimit: true },
    inheritsParentContext: overrides.inheritsParentContext ?? false,
    start: overrides.start ?? ((request) => {
      starts.push(request)
      const result = new Promise<unknown>((resolve, reject) => {
        settleResult = () => resolve({ stopReason: 'completed' })
        failResult = reject
      })
      // 不接住的话，测试里没人等这个 promise 会变成未处理拒绝。
      result.catch(() => undefined)
      return Promise.resolve({ result } satisfies SubagentRunLike)
    }),
    ...(overrides.prepareContinuable === undefined ? {} : { prepareContinuable: overrides.prepareContinuable }),
  }
  return {
    provider,
    starts,
    finish: () => settleResult?.(),
    fail: (error: Error) => failResult?.(error),
  }
}

/** 一个只认一支队的配额反查。 */
function quota(limit: number, key = 'vela-a'): SlottedProviderDeps['quotaFor'] {
  return () => Promise.resolve({ key, limit })
}

function request(signal = new AbortController().signal): SubagentStartRequestLike {
  return { parent: { ctx: {} }, signal }
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('号牌 provider：转发', () => {
  it('名字加上 vela- 前缀，与原生的区分开', () => {
    const { provider } = fakeInner({ name: 'fork' })
    const wrapped = slottedProvider(provider, { slots: pool(), quotaFor: quota(1) })
    assert.equal(wrapped.name, `${VELA_PROVIDER_PREFIX}fork`)
  })

  it('能力标记逐字转发——服务层拿它校验白名单支不支持', () => {
    const capabilities = { toolFilter: true, persona: true, depthLimit: true, outputSchema: false }
    const { provider } = fakeInner({ capabilities })
    const wrapped = slottedProvider(provider, { slots: pool(), quotaFor: quota(1) })
    assert.deepEqual(wrapped.capabilities, capabilities)
  })

  it('inheritsParentContext 逐字转发——模型层拿它生成措辞', () => {
    const { provider } = fakeInner({ inheritsParentContext: true })
    const wrapped = slottedProvider(provider, { slots: pool(), quotaFor: quota(1) })
    assert.equal(wrapped.inheritsParentContext, true)
  })

  it('请求原样传给被包的那个，不做任何加工', async () => {
    const inner = fakeInner()
    const wrapped = slottedProvider(inner.provider, { slots: pool(), quotaFor: quota(2) })
    const sent = request()
    await wrapped.start(sent)
    assert.equal(inner.starts.length, 1)
    assert.equal(inner.starts[0], sent, '必须是同一个对象')
  })
})

describe('号牌 provider：闸门', () => {
  it('满额时第二个队员起不来，第一个结束后才放行', async () => {
    const inner = fakeInner()
    const slots = pool()
    const wrapped = slottedProvider(inner.provider, { slots, quotaFor: quota(1) })

    await wrapped.start(request())
    let secondStarted = false
    void wrapped.start(request()).then(() => { secondStarted = true })
    await settle()
    // 这就是「硬拦截」：被包的那个 provider 的 start 还没被调第二次。
    assert.equal(inner.starts.length, 1)
    assert.equal(secondStarted, false)

    inner.finish()
    await settle()
    assert.equal(inner.starts.length, 2)
    assert.equal(secondStarted, true)
  })

  it('结果 reject 时也还牌——出故障还攥着牌会让那支队一次比一次慢', async () => {
    const inner = fakeInner()
    const slots = pool()
    const wrapped = slottedProvider(inner.provider, { slots, quotaFor: quota(1) })
    await wrapped.start(request())
    assert.equal(slots.heldFor('vela-a'), 1)
    inner.fail(new Error('子代理进程崩了'))
    await settle()
    assert.equal(slots.heldFor('vela-a'), 0)
  })

  it('起跑本身失败时当场还牌', async () => {
    const slots = pool()
    const { provider } = fakeInner({ start: () => Promise.reject(new Error('起不来')) })
    const wrapped = slottedProvider(provider, { slots, quotaFor: quota(1) })
    await assert.rejects(() => wrapped.start(request()), /起不来/)
    // 不还的话这支队白丢一个坑位，而且再也拿不回来。
    assert.equal(slots.heldFor('vela-a'), 0)
  })

  it('排队期间被取消，被包的 provider 一次都没被调', async () => {
    const inner = fakeInner()
    const slots = pool()
    const wrapped = slottedProvider(inner.provider, { slots, quotaFor: quota(1) })
    await wrapped.start(request())
    const controller = new AbortController()
    let failure: unknown
    void wrapped.start(request(controller.signal)).catch((error: unknown) => { failure = error })
    await settle()
    controller.abort('这张卡被取消了')
    await settle()
    assert.notEqual(failure, undefined)
    assert.equal(inner.starts.length, 1, '取消掉的队员不该起跑')
  })

  it('配额反查说「这不是小队」时直接转发，不设闸门', async () => {
    const inner = fakeInner()
    const slots = pool()
    const wrapped = slottedProvider(inner.provider, {
      slots,
      quotaFor: () => Promise.resolve(undefined),
    })
    await wrapped.start(request())
    await wrapped.start(request())
    await wrapped.start(request())
    assert.equal(inner.starts.length, 3)
    assert.equal(slots.heldFor('vela-a'), 0, '一张牌都不该被领')
  })

  it('配额反查自己抛错时不挡住派活，只记一句', async () => {
    const inner = fakeInner()
    const warnings: unknown[] = []
    const wrapped = slottedProvider(inner.provider, {
      slots: pool(),
      quotaFor: () => Promise.reject(new Error('读不出小队')),
      logger: { warn: message => warnings.push(message) },
    })
    // 一个诊断信息问题不该升级成「队员起不来」。
    await wrapped.start(request())
    assert.equal(inner.starts.length, 1)
    assert.equal(warnings.length, 1)
  })

  it('两支队各自算账', async () => {
    const inner = fakeInner()
    const slots = pool()
    let which = 'vela-a'
    const wrapped = slottedProvider(inner.provider, {
      slots,
      quotaFor: () => Promise.resolve({ key: which, limit: 1 }),
    })
    await wrapped.start(request())
    which = 'vela-b'
    await wrapped.start(request())
    assert.equal(inner.starts.length, 2, 'b 队不该被 a 队占满而拦住')
  })
})

describe('号牌 provider：可继续子代理这条路', () => {
  it('被包者支持时转发，且不领号牌', async () => {
    const slots = pool()
    let forwarded = false
    const { provider } = fakeInner({
      prepareContinuable: () => {
        forwarded = true
        return Promise.resolve({ seedWithParentHistory: false })
      },
    })
    const wrapped = slottedProvider(provider, { slots, quotaFor: quota(1) })
    // 类型上它是可选的（那正是重点），所以这里先断定它真的在。
    if (wrapped.prepareContinuable === undefined) throw new Error('包装后应当保留这个方法')
    await wrapped.prepareContinuable({})
    assert.equal(forwarded, true)
    // 刻意不领：这条路上没有结束信号，领了必然漏还，而漏还比少拦一条路更糟。
    assert.equal(slots.heldFor('vela-a'), 0)
  })

  it('被包者不支持时，包出来的对象上根本没有这个方法', () => {
    const { provider } = fakeInner()
    assert.equal(provider.prepareContinuable, undefined)
    const service: SubagentsServiceLike = {
      getProvider: name => (name === 'spawn' ? provider : undefined),
      registerProvider: () => () => {},
    }
    const [wrapped] = slottedProvidersFor(service, { slots: pool(), quotaFor: quota(1) })
    // DSH 靠属性的**有无**判断支不支持，不是靠返回值。留着一个会抛错的方法
    // 等于骗它说「我支持」。
    assert.equal('prepareContinuable' in (wrapped as object), false)
  })

  it('被包者支持时，包出来的对象上有这个方法', () => {
    const { provider } = fakeInner({
      prepareContinuable: () => Promise.resolve({ seedWithParentHistory: true }),
    })
    const service: SubagentsServiceLike = {
      getProvider: name => (name === 'spawn' ? provider : undefined),
      registerProvider: () => () => {},
    }
    const [wrapped] = slottedProvidersFor(service, { slots: pool(), quotaFor: quota(1) })
    assert.equal('prepareContinuable' in (wrapped as object), true)
  })
})

describe('号牌 provider：时间轴记录', () => {
  /** 一个记下调用的假记录器。 */
  function fakeSink() {
    const starts: { parent: string; span: Record<string, unknown> }[] = []
    const ends: { parent: string; runId: string; at: number; stopReason: string | undefined; summary: string | undefined }[] = []
    return {
      sink: {
        start: (parent: string, span: Record<string, unknown>) => { starts.push({ parent, span }) },
        end: (parent: string, runId: string, at: number, stopReason: string | undefined, summary?: string) => {
          ends.push({ parent, runId, at, stopReason, summary })
        },
      },
      starts,
      ends,
    }
  }

  const members = [
    { name: 'worker_a', instruction: '你只做 a' },
    { name: 'worker_b', instruction: '你只做 b' },
  ]

  function withTimeline(recorder: ReturnType<typeof fakeSink>): SlottedProviderDeps {
    return {
      slots: pool(),
      quotaFor: () => Promise.resolve({ key: 'vela-a', limit: 3, members }),
      timeline: recorder.sink,
      now: () => 1000,
    }
  }

  it('起跑与结束都被记下，带上父会话与子会话身份', async () => {
    const recorder = fakeSink()
    const inner = fakeInner({
      start: () => Promise.resolve({
        id: 'child-1',
        result: Promise.resolve({ stopReason: 'completed' }),
      }),
    })
    const wrapped = slottedProvider(inner.provider, withTimeline(recorder))
    await wrapped.start({ ...request(), parent: { ctx: {}, id: 'parent-1' }, label: '建 a' })
    await settle()
    assert.equal(recorder.starts.length, 1)
    assert.equal(recorder.starts[0]?.parent, 'parent-1')
    assert.equal(recorder.starts[0]?.span.sessionId, 'child-1')
    assert.equal(recorder.starts[0]?.span.label, '建 a')
    assert.equal(recorder.ends.length, 1)
    assert.equal(recorder.ends[0]?.stopReason, 'completed')
  })

  it('队员名从请求根上的 persona 反查——one-shot 的 descriptor 里没有它', async () => {
    const recorder = fakeSink()
    const inner = fakeInner({
      start: () => Promise.resolve({ id: 'c1', result: Promise.resolve({ stopReason: 'completed' }) }),
    })
    const wrapped = slottedProvider(inner.provider, withTimeline(recorder))
    // 这正是一次真跑抓到的坑：之前只读 `descriptor.persona`，而 one-shot 模式的
    // descriptor 快照里根本没有 persona，于是队员名全部反查失败。
    await wrapped.start({
      ...request(),
      parent: { ctx: {}, id: 'p1' },
      label: '建 a',
      persona: '你只做 a',
    })
    await settle()
    assert.equal(recorder.starts[0]?.span.member, 'worker_a')
  })

  it('职责说明对不上任何队员时不猜一个', async () => {
    const recorder = fakeSink()
    const inner = fakeInner({
      start: () => Promise.resolve({ id: 'c1', result: Promise.resolve({ stopReason: 'completed' }) }),
    })
    const wrapped = slottedProvider(inner.provider, withTimeline(recorder))
    await wrapped.start({
      ...request(),
      parent: { ctx: {}, id: 'p1' },
      persona: '不属于任何队员的职责',
    })
    await settle()
    assert.equal(recorder.starts[0]?.span.member, undefined)
  })

  it('两个队员职责完全相同时不猜——那时它们本来就无法区分', async () => {
    const recorder = fakeSink()
    const inner = fakeInner({
      start: () => Promise.resolve({ id: 'c1', result: Promise.resolve({ stopReason: 'completed' }) }),
    })
    const wrapped = slottedProvider(inner.provider, {
      slots: pool(),
      quotaFor: () => Promise.resolve({
        key: 'vela-a',
        limit: 3,
        members: [{ name: 'x', instruction: '一模一样' }, { name: 'y', instruction: '一模一样' }],
      }),
      timeline: recorder.sink,
      now: () => 1000,
    })
    await wrapped.start({ ...request(), parent: { ctx: {}, id: 'p1' }, persona: '一模一样' })
    await settle()
    assert.equal(recorder.starts[0]?.span.member, undefined)
  })

  it('persona 带着 Vela 追加的结束约定时仍能认出队员——反查认前缀', async () => {
    // persona = 职责原文 + 结束约定（见 squad.ts 的 memberPersona）。这是新默认，
    // 反查必须跟得上，否则所有泳道的队员名会全部丢失。
    const recorder = fakeSink()
    const inner = fakeInner({
      start: () => Promise.resolve({ id: 'c1', result: Promise.resolve({ stopReason: 'completed' }) }),
    })
    const wrapped = slottedProvider(inner.provider, withTimeline(recorder))
    await wrapped.start({
      ...request(),
      parent: { ctx: {}, id: 'p1' },
      label: '建 a',
      persona: '你只做 a\n\n结束时，你的最后一条消息用一两句话说明：做了什么、结果如何。',
    })
    await settle()
    assert.equal(recorder.starts[0]?.span.member, 'worker_a')
  })

  it('两个队员职责互为前缀时取最长的那个——最具体的才是真的', async () => {
    const recorder = fakeSink()
    const inner = fakeInner({
      start: () => Promise.resolve({ id: 'c1', result: Promise.resolve({ stopReason: 'completed' }) }),
    })
    const wrapped = slottedProvider(inner.provider, {
      slots: pool(),
      quotaFor: () => Promise.resolve({
        key: 'vela-a',
        limit: 3,
        members: [
          { name: 'coder', instruction: '你写代码' },
          { name: 'tester', instruction: '你写代码并跑测试' },
        ],
      }),
      timeline: recorder.sink,
      now: () => 1000,
    })
    await wrapped.start({
      ...request(),
      parent: { ctx: {}, id: 'p1' },
      persona: '你写代码并跑测试\n\n结束约定',
    })
    await settle()
    assert.equal(recorder.starts[0]?.span.member, 'tester')
  })

  it('队员最后一条消息的文本被记下当总结——验收不用翻整场会话', async () => {
    const recorder = fakeSink()
    const inner = fakeInner({
      start: () => Promise.resolve({
        id: 'c1',
        result: Promise.resolve({
          stopReason: 'completed',
          output: [{ type: 'text', text: '建好了 slot-a.txt，内容是一行 a。' }],
        }),
      }),
    })
    const wrapped = slottedProvider(inner.provider, withTimeline(recorder))
    await wrapped.start({ ...request(), parent: { ctx: {}, id: 'p1' }, label: '建 a', persona: '你只做 a' })
    await settle()
    assert.equal(recorder.ends[0]?.summary, '建好了 slot-a.txt，内容是一行 a。')
  })

  it('队员什么也没说时总结缺省，不造一句假的', async () => {
    const recorder = fakeSink()
    const inner = fakeInner({
      start: () => Promise.resolve({ id: 'c1', result: Promise.resolve({ stopReason: 'completed', output: [] }) }),
    })
    const wrapped = slottedProvider(inner.provider, withTimeline(recorder))
    await wrapped.start({ ...request(), parent: { ctx: {}, id: 'p1' }, label: '建 a', persona: '你只做 a' })
    await settle()
    assert.equal(recorder.ends[0]?.summary, undefined)
  })

  it('超长总结被截断——泳道下方不是报告全文，全文点泳道进会话看', async () => {
    const recorder = fakeSink()
    const inner = fakeInner({
      start: () => Promise.resolve({
        id: 'c1',
        result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: '长'.repeat(400) }] }),
      }),
    })
    const wrapped = slottedProvider(inner.provider, withTimeline(recorder))
    await wrapped.start({ ...request(), parent: { ctx: {}, id: 'p1' }, label: '建 a', persona: '你只做 a' })
    await settle()
    const summary = recorder.ends[0]?.summary ?? ''
    assert.equal(summary.length, 280)
    assert.ok(summary.endsWith('…'))
  })

  it('基础设施故障也记下收尾，且停止原因不置空', async () => {
    const recorder = fakeSink()
    const failing = Promise.reject(new Error('子进程崩了'))
    failing.catch(() => undefined)
    const inner = fakeInner({ start: () => Promise.resolve({ id: 'c1', result: failing }) })
    const wrapped = slottedProvider(inner.provider, withTimeline(recorder))
    await wrapped.start({ ...request(), parent: { ctx: {}, id: 'p1' } })
    await settle()
    // 置空会让这条泳道看起来像正常结束。
    assert.equal(recorder.ends[0]?.stopReason, 'infrastructure-error')
  })

  it('拿不到父会话 id 时什么也不记，不造一条带占位符的泳道', async () => {
    const recorder = fakeSink()
    const inner = fakeInner({
      start: () => Promise.resolve({ id: 'c1', result: Promise.resolve({ stopReason: 'completed' }) }),
    })
    const wrapped = slottedProvider(inner.provider, withTimeline(recorder))
    // parent 没有 id。
    await wrapped.start(request())
    await settle()
    assert.equal(recorder.starts.length, 0)
  })

  it('拿不到子会话 id 时也不记——一条点不进去的泳道比没有那条更坏', async () => {
    const recorder = fakeSink()
    const inner = fakeInner()
    const wrapped = slottedProvider(inner.provider, withTimeline(recorder))
    await wrapped.start({ ...request(), parent: { ctx: {}, id: 'p1' } })
    await settle()
    assert.equal(recorder.starts.length, 0)
  })

  it('不接记录器时号牌照常工作——时间轴是可选能力', async () => {
    const inner = fakeInner()
    const slots = pool()
    const wrapped = slottedProvider(inner.provider, { slots, quotaFor: quota(1) })
    await wrapped.start(request())
    assert.equal(slots.heldFor('vela-a'), 1)
    assert.equal(inner.starts.length, 1)
  })
})

describe('号牌 provider：挂载', () => {
  it('把 spawn 与 fork 都包上并注册', () => {
    const registered: string[] = []
    const service: SubagentsServiceLike = {
      getProvider: name => fakeInner({ name }).provider,
      registerProvider: (provider) => {
        registered.push(provider.name)
        return () => {}
      },
    }
    installSlottedProviders(service, { slots: pool(), quotaFor: quota(1) })
    assert.deepEqual(registered, ['vela-spawn', 'vela-fork'])
  })

  it('缺一个原生后端就跳过它，不影响另一个', () => {
    const registered: string[] = []
    const warnings: unknown[] = []
    const service: SubagentsServiceLike = {
      getProvider: name => (name === 'spawn' ? fakeInner({ name }).provider : undefined),
      registerProvider: (provider) => {
        registered.push(provider.name)
        return () => {}
      },
    }
    installSlottedProviders(service, {
      slots: pool(),
      quotaFor: quota(1),
      logger: { warn: message => warnings.push(message) },
    })
    assert.deepEqual(registered, ['vela-spawn'])
    assert.equal(warnings.length, 1, '少一个后端要说出来')
  })

  it('一个注册失败不拖垮另一个——HMR 残留的旧注册最可能撞名', () => {
    const registered: string[] = []
    const warnings: unknown[] = []
    const service: SubagentsServiceLike = {
      getProvider: name => fakeInner({ name }).provider,
      registerProvider: (provider) => {
        if (provider.name === 'vela-spawn') throw new Error('DUPLICATE_PROVIDER')
        registered.push(provider.name)
        return () => {}
      },
    }
    installSlottedProviders(service, {
      slots: pool(),
      quotaFor: quota(1),
      logger: { warn: message => warnings.push(message) },
    })
    assert.deepEqual(registered, ['vela-fork'])
    assert.equal(warnings.length, 1)
  })

  it('卸载会撤掉每一个注册', () => {
    const disposed: string[] = []
    const service: SubagentsServiceLike = {
      getProvider: name => fakeInner({ name }).provider,
      registerProvider: provider => () => disposed.push(provider.name),
    }
    const dispose = installSlottedProviders(service, { slots: pool(), quotaFor: quota(1) })
    dispose()
    assert.deepEqual(disposed, ['vela-spawn', 'vela-fork'])
  })

  it('某个卸载自己抛错也不能把插件卸载整个拖垮', () => {
    const disposed: string[] = []
    const service: SubagentsServiceLike = {
      getProvider: name => fakeInner({ name }).provider,
      registerProvider: provider => () => {
        if (provider.name === 'vela-spawn') throw new Error('已经没了')
        disposed.push(provider.name)
      },
    }
    const dispose = installSlottedProviders(service, { slots: pool(), quotaFor: quota(1) })
    dispose()
    assert.deepEqual(disposed, ['vela-fork'])
  })
})
