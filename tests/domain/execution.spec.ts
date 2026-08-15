/**
 * 纯函数层的行为契约：用量折叠、结束原因解析、执行配置解析。
 *
 * 这三块都在 HTTP 面之下，但单独测是因为它们的边界（缺失用量 vs 零用量、
 * 未知结束原因、覆盖回落组合）从 HTTP 面很难驱动到。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  addUsage, billedInputTokens, foldUsage, readUsage, sumUsage, totalTokens, zeroUsage,
} from '../../src/domain/usage.ts'
import { defaultFailure, parseTurnEnd } from '../../src/domain/outcome.ts'
import { resolveExec, validateOverrides } from '../../src/domain/exec.ts'

describe('readUsage', () => {
  it('没有 usage 字段时返回 undefined——「没报用量」不等于「花了 0」', () => {
    assert.equal(readUsage({}), undefined)
    assert.equal(readUsage({ usage: null }), undefined)
    assert.equal(readUsage(undefined), undefined)
    assert.equal(readUsage('nonsense'), undefined)
  })

  it('usage 对象里一个数字字段都没有时也算未报', () => {
    assert.equal(readUsage({ usage: { note: 'hi' } }), undefined)
  })

  it('缺失的可选计数补 0，已有的原样读出', () => {
    assert.deepEqual(readUsage({ usage: { inputTokens: 10, outputTokens: 3 } }), {
      inputTokens: 10, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
    })
  })

  it('负数与非有限值被当作 0，不污染总计', () => {
    const usage = readUsage({ usage: { inputTokens: -5, outputTokens: Number.NaN, cacheReadTokens: 7 } })
    assert.deepEqual(usage, {
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 7, cacheWriteTokens: 0, reasoningTokens: 0,
    })
  })
})

describe('foldUsage', () => {
  it('整段没有任何用量时返回 undefined（卡片应显示未知而非 0）', () => {
    assert.equal(foldUsage([{ type: 'turn/start' }, { type: 'turn/end' }]), undefined)
  })

  it('只累加 assistant/message，其他事件即使带 usage 也不算', () => {
    const total = foldUsage([
      { type: 'assistant/message', data: { usage: { inputTokens: 1, outputTokens: 2 } } },
      { type: 'tool/result', data: { usage: { inputTokens: 100, outputTokens: 100 } } },
      { type: 'assistant/message', data: { usage: { inputTokens: 3, outputTokens: 4 } } },
    ])
    assert.equal(total?.inputTokens, 4)
    assert.equal(total?.outputTokens, 6)
  })

  it('跳过缺 usage 的消息而不是把它算成 0', () => {
    const total = foldUsage([
      { type: 'assistant/message', data: {} },
      { type: 'assistant/message', data: { usage: { inputTokens: 5, outputTokens: 5 } } },
    ])
    assert.deepEqual(total, {
      inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
    })
  })
})

describe('计费口径', () => {
  it('计费输入是三类互斥输入之和', () => {
    const usage = {
      inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40, reasoningTokens: 5,
    }
    assert.equal(billedInputTokens(usage), 80)
    // 推理 token 已含在输出里，不再单独加。
    assert.equal(totalTokens(usage), 100)
  })

  it('相加逐字段进行', () => {
    const sum = addUsage(zeroUsage(), {
      inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, reasoningTokens: 5,
    })
    assert.equal(totalTokens(sum), 1 + 3 + 4 + 2)
  })

  it('累计时忽略缺失用量的 Run；全都缺失则整体未知', () => {
    const one = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
    assert.equal(sumUsage([undefined, one, undefined])?.inputTokens, 1)
    assert.equal(sumUsage([undefined, undefined]), undefined)
    assert.equal(sumUsage([]), undefined)
  })
})

describe('parseTurnEnd', () => {
  it('completed 就是成功，且不带失败说明', () => {
    assert.deepEqual(parseTurnEnd({ reason: { kind: 'completed' } }), { outcome: 'completed' })
  })

  it('六个已知结束原因各自映射到对应结局', () => {
    for (const kind of ['aborted', 'blocked', 'error', 'max-tokens', 'interrupted']) {
      assert.equal(parseTurnEnd({ reason: { kind } }).outcome, kind)
    }
  })

  it('error 分支把 provider 的 code 与 message 带进失败说明', () => {
    const end = parseTurnEnd({ reason: { kind: 'error', error: { code: 'rate_limit', message: 'slow down' } } })
    assert.equal(end.outcome, 'error')
    assert.equal(end.failure, 'rate_limit: slow down')
  })

  it('未知结束原因归为 error 而不是 completed——把未知当成功是最坏的失败模式', () => {
    const end = parseTurnEnd({ reason: { kind: 'something-new' } })
    assert.equal(end.outcome, 'error')
    assert.match(end.failure ?? '', /something-new/)
  })

  it('载荷完全无法辨认时也归为 error', () => {
    assert.equal(parseTurnEnd(undefined).outcome, 'error')
    assert.equal(parseTurnEnd({}).outcome, 'error')
    assert.equal(parseTurnEnd({ reason: 'oops' }).outcome, 'error')
  })

  it('没有细节时用该结局的默认说明', () => {
    assert.equal(parseTurnEnd({ reason: { kind: 'max-tokens' } }).failure, defaultFailure('max-tokens'))
  })
})

describe('resolveExec', () => {
  it('Issue 的覆盖值优先于全局默认', () => {
    const resolved = resolveExec(
      { agentPreset: 'careful', sandbox: 'read-only', timeoutMs: 1000 },
      { agentPreset: 'default', sandbox: 'workspace-write', timeoutMs: 9999 },
    )
    assert.deepEqual(resolved, { agentPreset: 'careful', sandbox: 'read-only', timeoutMs: 1000 })
  })

  it('未覆盖的项回落到全局默认', () => {
    const resolved = resolveExec({ sandbox: 'read-only' }, { agentPreset: 'default', timeoutMs: 5000 })
    assert.deepEqual(resolved, { agentPreset: 'default', sandbox: 'read-only', timeoutMs: 5000 })
  })

  it('两边都没有时该项缺席，超时归 0（不限时）', () => {
    assert.deepEqual(resolveExec({}, {}), { timeoutMs: 0 })
  })

  it('负数或非有限的超时被归成不限时，而不是立刻超时', () => {
    assert.equal(resolveExec({ timeoutMs: -1 }, {}).timeoutMs, 0)
    assert.equal(resolveExec({ timeoutMs: Number.POSITIVE_INFINITY }, {}).timeoutMs, 0)
  })
})

describe('validateOverrides', () => {
  it('空覆盖总是合法', () => {
    assert.equal(validateOverrides({}, []), undefined)
  })

  it('sandbox 必须是宿主实际提供的 preset 名字之一', () => {
    assert.equal(validateOverrides({ sandbox: 'workspace-write' }, ['workspace-write', 'danger']), undefined)
    assert.match(validateOverrides({ sandbox: 'nope' }, ['workspace-write']) ?? '', /unknown sandbox preset/)
  })

  it('部署一个 preset 都不提供时拒绝设置 sandbox', () => {
    assert.match(validateOverrides({ sandbox: 'workspace-write' }, []) ?? '', /no permission presets/)
  })

  it('拒绝负数超时与空白 preset 名', () => {
    assert.match(validateOverrides({ timeoutMs: -1 }, []) ?? '', /non-negative/)
    assert.match(validateOverrides({ agentPreset: '  ' }, []) ?? '', /must not be blank/)
  })
})
