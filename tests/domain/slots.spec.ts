/**
 * 号牌（Delegation Slot）的语义（ADR-0018）。
 *
 * 这些测试全部用**假时钟**：真实的并发时序无法在测试里复现，而号牌的每一条规矩
 * 都是关于「谁在什么时刻能起跑」。把计时器注入进来之后，超时回收这类平时几小时
 * 才发生一次的路径也能确定性地测到。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SlotAbortedError, SlotPool } from '../../src/domain/slots.ts'

/** 一个可以手动推进的假时钟。 */
function fakeClock() {
  const pending = new Map<number, { readonly fn: () => void; readonly at: number }>()
  let next = 1
  let now = 0
  return {
    setTimer: (fn: () => void, ms: number): unknown => {
      const handle = next
      next += 1
      pending.set(handle, { fn, at: now + ms })
      return handle
    },
    clearTimer: (handle: unknown): void => {
      pending.delete(handle as number)
    },
    /** 推进时间并跑掉所有到期的计时器。 */
    advance: (ms: number): void => {
      now += ms
      for (const [handle, timer] of [...pending]) {
        if (timer.at <= now) {
          pending.delete(handle)
          timer.fn()
        }
      }
    },
    pendingCount: (): number => pending.size,
  }
}

/** 一个不做对账的池（maxHoldMs 关掉），用于测排队语义本身。 */
function poolWithoutReconcile(): SlotPool {
  const clock = fakeClock()
  return new SlotPool({ setTimer: clock.setTimer, clearTimer: clock.clearTimer, maxHoldMs: 0 })
}

/** 让已经 resolve 的 promise 有机会跑完它们的回调。 */
async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('号牌：领与还', () => {
  it('没到上限就直接放行', async () => {
    const pool = poolWithoutReconcile()
    await pool.acquire('vela-a', 2)
    await pool.acquire('vela-a', 2)
    assert.equal(pool.heldFor('vela-a'), 2)
    assert.equal(pool.waitingFor('vela-a'), 0)
  })

  it('满额时第三个人排队，而不是被拒绝', async () => {
    const pool = poolWithoutReconcile()
    await pool.acquire('vela-a', 2)
    await pool.acquire('vela-a', 2)
    let started = false
    void pool.acquire('vela-a', 2).then(() => { started = true })
    await settle()
    // 这是「硬拦截」的定义：第三个队员根本还没起跑。
    assert.equal(started, false)
    assert.equal(pool.waitingFor('vela-a'), 1)
  })

  it('有人还牌，排在最前面的立刻起跑', async () => {
    const pool = poolWithoutReconcile()
    const first = await pool.acquire('vela-a', 1)
    let started = false
    void pool.acquire('vela-a', 1).then(() => { started = true })
    await settle()
    assert.equal(started, false)
    first.release()
    await settle()
    assert.equal(started, true)
    // 坑位从上一张牌直接转给下一个人，因此持有数不变。
    assert.equal(pool.heldFor('vela-a'), 1)
  })

  it('先排队的先起跑', async () => {
    const pool = poolWithoutReconcile()
    const first = await pool.acquire('vela-a', 1)
    const order: string[] = []
    void pool.acquire('vela-a', 1).then(() => order.push('二'))
    void pool.acquire('vela-a', 1).then(() => order.push('三'))
    await settle()
    first.release()
    await settle()
    assert.deepEqual(order, ['二'])
  })

  it('同一张牌还两次只还一个坑位', async () => {
    const pool = poolWithoutReconcile()
    const ticket = await pool.acquire('vela-a', 2)
    await pool.acquire('vela-a', 2)
    ticket.release()
    ticket.release()
    ticket.release()
    // 不幂等的话这里会变成 -1，那支队的上限就此凭空变大。
    assert.equal(pool.heldFor('vela-a'), 1)
  })

  it('两支队各自算账——一支满了不该拦住另一支', async () => {
    const pool = poolWithoutReconcile()
    await pool.acquire('vela-a', 1)
    let bStarted = false
    void pool.acquire('vela-b', 1).then(() => { bStarted = true })
    await settle()
    assert.equal(bStarted, true)
  })

  it('上限每次重新取，改小队设置不用重启', async () => {
    const pool = poolWithoutReconcile()
    const first = await pool.acquire('vela-a', 1)
    let started = false
    // Operator 把号牌从 1 改成 2，下一次领牌就该按 2 来。
    void pool.acquire('vela-a', 2).then(() => { started = true })
    await settle()
    assert.equal(started, true)
    first.release()
  })

  it('上限非正整数视为不限，且那张空牌还了也不出乱子', async () => {
    const pool = poolWithoutReconcile()
    for (const limit of [0, -1, 1.5, Number.NaN]) {
      const ticket = await pool.acquire('vela-a', limit)
      ticket.release()
    }
    assert.equal(pool.heldFor('vela-a'), 0)
  })
})

describe('号牌：取消', () => {
  it('排队期间被取消，那个队员不会在取消之后才冒出来', async () => {
    const pool = poolWithoutReconcile()
    const first = await pool.acquire('vela-a', 1)
    const controller = new AbortController()
    let started = false
    let failure: unknown
    void pool.acquire('vela-a', 1, controller.signal)
      .then(() => { started = true }, (error: unknown) => { failure = error })
    await settle()
    controller.abort('这张卡被取消了')
    await settle()
    assert.equal(failure instanceof SlotAbortedError, true)
    assert.equal((failure as Error).message, '这张卡被取消了')
    assert.equal(pool.waitingFor('vela-a'), 0, '必须从队列里摘掉')
    // 关键：即使之后有人还牌，那个已取消的队员也不该起跑。
    first.release()
    await settle()
    assert.equal(started, false)
  })

  it('已经取消的 signal 直接拒，不占坑位', async () => {
    const pool = poolWithoutReconcile()
    const controller = new AbortController()
    controller.abort('早就取消了')
    await assert.rejects(() => pool.acquire('vela-a', 3, controller.signal), SlotAbortedError)
    assert.equal(pool.heldFor('vela-a'), 0)
  })

  it('drainWaiting 清空整支队的队列，已在跑的不受影响', async () => {
    const pool = poolWithoutReconcile()
    await pool.acquire('vela-a', 1)
    const failures: unknown[] = []
    void pool.acquire('vela-a', 1).catch((error: unknown) => failures.push(error))
    void pool.acquire('vela-a', 1).catch((error: unknown) => failures.push(error))
    await settle()
    assert.equal(pool.drainWaiting('vela-a', '整张卡被取消了'), 2)
    await settle()
    assert.equal(failures.length, 2)
    assert.equal((failures[0] as Error).message, '整张卡被取消了')
    // 已经在跑的那个队员仍然持有它的牌——停它是 DSH 取消路径的事。
    assert.equal(pool.heldFor('vela-a'), 1)
  })

  it('清一支不存在的队返回 0，不抛错', () => {
    const pool = poolWithoutReconcile()
    assert.equal(pool.drainWaiting('vela-nope', '随便'), 0)
  })
})

describe('号牌：超时对账', () => {
  it('结束信号没来时号牌最终被强制回收', async () => {
    const clock = fakeClock()
    const pool = new SlotPool({
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      maxHoldMs: 1000,
    })
    // 拿了牌就再也不还——模拟结束信号根本没送到。
    await pool.acquire('vela-a', 1)
    let started = false
    void pool.acquire('vela-a', 1).then(() => { started = true })
    await settle()
    assert.equal(started, false)

    clock.advance(1000)
    await settle()
    // 没有这道对账，漏还一张牌会永久缩小那支队的并发能力，症状是「越用越慢」。
    assert.equal(started, true, '超时后坑位必须被回收')
  })

  it('正常还牌会撤掉对账计时器，不留下泄漏', async () => {
    const clock = fakeClock()
    const pool = new SlotPool({
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      maxHoldMs: 1000,
    })
    const ticket = await pool.acquire('vela-a', 1)
    assert.equal(clock.pendingCount(), 1)
    ticket.release()
    assert.equal(clock.pendingCount(), 0)
  })

  it('对账触发后迟到的结束信号不会多还一个坑位', async () => {
    const clock = fakeClock()
    const warnings: unknown[] = []
    const pool = new SlotPool({
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      maxHoldMs: 1000,
      logger: { warn: message => warnings.push(message) },
    })
    // 上限 1，一人持有一人排队。这个形状才能真正观测到「多还了一个坑位」：
    // 对账把坑位转给排队者之后，迟到的 release 如果不幂等就会把那个正在
    // 跑的队员的坑位也还掉，于是那支队凭空多出一个并发名额。
    const stale = await pool.acquire('vela-a', 1)
    let secondStarted = false
    void pool.acquire('vela-a', 1).then(() => { secondStarted = true })
    await settle()

    clock.advance(1000)
    await settle()
    assert.equal(secondStarted, true, '对账应当把坑位转给排队者')
    assert.equal(pool.heldFor('vela-a'), 1)
    assert.equal(warnings.length, 1, '强制回收要留一条可诊断的记录')

    // 迟到的结束信号：牌已经被对账回收了，这一下必须是空操作。
    stale.release()
    assert.equal(pool.heldFor('vela-a'), 1, '现在跑着的那个队员的坑位不能被还掉')
  })

  it('同一时刻领的多张牌在同一时刻到期，全部被回收', async () => {
    const clock = fakeClock()
    const pool = new SlotPool({
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      maxHoldMs: 1000,
    })
    await pool.acquire('vela-a', 3)
    await pool.acquire('vela-a', 3)
    assert.equal(pool.heldFor('vela-a'), 2)
    clock.advance(1000)
    // 对账是每张牌各自计时的，不是整支队一个计时器。
    assert.equal(pool.heldFor('vela-a'), 0)
  })

  it('maxHoldMs 为 0 时不装对账计时器', async () => {
    const clock = fakeClock()
    const pool = new SlotPool({
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      maxHoldMs: 0,
    })
    await pool.acquire('vela-a', 1)
    assert.equal(clock.pendingCount(), 0)
  })
})
