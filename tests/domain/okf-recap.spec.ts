/**
 * Recap 的行为契约（ADR-0021 / 0023 / 0025）。
 *
 * 三处最容易出错、也最值钱的地方在这里被钉住：信任等级是**推导**的、陈旧
 * 的边界在哪一天、以及 Agent 交付缺失时不伪造正文。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  RECAP_TYPE, OPERATOR_ACTOR, STALE_AFTER_DAYS,
  buildRecap, bumpUsageCount, extractDelivery, formatUsage, isStale, markDeprecated, markVerified,
  readRecap, recapRelativePath, repeatedReadsOf, sectionOf, staleAfterFor, toDateStamp, trustLevelOf,
  workspaceSlug,
} from '../../src/domain/okf-recap.ts'
import type { RunFacts } from '../../src/domain/okf-recap.ts'

const AT = Date.parse('2026-08-17T09:00:00.000Z')

/**
 * 可覆盖项。允许显式传 `undefined` 表示「这一项缺失」——缺失与 0 在这个
 * 领域里是两件事（用量缺失 = 未知），测试必须能造出前者。
 */
type FactOverrides = Partial<Omit<RunFacts, 'usage' | 'recall' | 'failure'>> & {
  readonly usage?: RunFacts['usage'] | undefined
  readonly recall?: RunFacts['recall'] | undefined
  readonly failure?: string | undefined
}

/** 一份最小事实。测试只覆盖它关心的那几项。 */
function facts(overrides: FactOverrides = {}): RunFacts {
  const merged = {
    issueNumber: 12,
    runSeq: 1,
    sessionId: 'ses-1',
    workspace: 'd:\\Code\\Items\\JCoder\\Vela',
    title: '给 ordering 补测试',
    outcome: 'completed' as RunFacts['outcome'],
    startedAt: AT,
    endedAt: AT + 72_000,
    usage: {
      inputTokens: 12_345, outputTokens: 678, cacheReadTokens: 2_000, cacheWriteTokens: 0, reasoningTokens: 0,
    } as RunFacts['usage'],
    files: [{ path: 'src/domain/ordering.ts', reads: 3, writes: 1 }] as RunFacts['files'],
    commands: ['pnpm test'] as RunFacts['commands'],
    ...overrides,
  }
  const { usage, recall, failure, ...rest } = merged
  return {
    ...rest,
    ...(usage === undefined ? {} : { usage }),
    ...(recall === undefined ? {} : { recall }),
    ...(failure === undefined ? {} : { failure }),
  }
}

describe('信任等级是推导的', () => {
  it('没人审过就是 unverified', () => {
    assert.equal(trustLevelOf([]), 'unverified')
  })

  it('非人 actor 审过是 machine-confirmed', () => {
    // 本轮 Vela 不产生它，但读别人的知识包时会遇到，推导必须认得。
    assert.equal(trustLevelOf([{ by: 'process:nightly-check', at: '2026-08-17T00:00:00.000Z' }]), 'machine-confirmed')
  })

  it('人审过就是 human-reviewed', () => {
    assert.equal(trustLevelOf([{ by: OPERATOR_ACTOR, at: '2026-08-17T00:00:00.000Z' }]), 'human-reviewed')
  })

  it('人与机器都审过时人赢', () => {
    // 人的判断是更强的信号，不该被机器那条冲淡。
    assert.equal(trustLevelOf([
      { by: 'process:nightly-check', at: '2026-08-17T00:00:00.000Z' },
      { by: OPERATOR_ACTOR, at: '2026-08-17T01:00:00.000Z' },
    ]), 'human-reviewed')
  })

  it('actor 为空或不是字符串的条目被跳过，不算审过', () => {
    assert.equal(trustLevelOf([{ by: '' }, { at: '2026-08-17T00:00:00.000Z' }]), 'unverified')
  })
})

describe('陈旧', () => {
  it('落盘日 + 90 天写进 stale_after', () => {
    const stamp = staleAfterFor(AT)
    assert.equal(stamp, toDateStamp(AT + STALE_AFTER_DAYS * 86_400_000))
    assert.equal(stamp, '2026-11-15')
  })

  it('到期当天还不陈旧', () => {
    // `stale_after` 读作「这一天之后陈旧」，边界含在有效期内。
    assert.equal(isStale('2026-11-15', Date.parse('2026-11-15T23:59:59.000Z')), false)
  })

  it('次日起陈旧', () => {
    assert.equal(isStale('2026-11-15', Date.parse('2026-11-16T00:00:01.000Z')), true)
  })

  it('缺字段或格式坏时不陈旧', () => {
    // 缺一个可选字段不该让一篇知识失效——OKF 要求消费者容忍缺失字段。
    assert.equal(isStale(undefined, AT), false)
    assert.equal(isStale('下个月', AT), false)
  })
})

describe('Workspace 目录名', () => {
  it('同一条路径每次得到同一个名字', () => {
    assert.equal(workspaceSlug('d:\\Code\\Vela'), workspaceSlug('d:\\Code\\Vela'))
  })

  it('末尾斜杠不影响结果', () => {
    assert.equal(workspaceSlug('/home/joe/vela/'), workspaceSlug('/home/joe/vela'))
  })

  it('两个同名但不同路径的仓库不撞进同一个目录', () => {
    // 只用目录名会让两个都叫 web 的仓库把记忆混在一起。
    assert.notEqual(workspaceSlug('/a/web'), workspaceSlug('/b/web'))
  })

  it('名字里带目录名，人看得出这堆记忆属于哪个项目', () => {
    assert.match(workspaceSlug('/home/joe/My Vela!'), /^my-vela-[0-9a-f]{8}$/)
  })

  it('目录名里一个合法字符都没有时不产生空名字', () => {
    assert.match(workspaceSlug('/---'), /^workspace-[0-9a-f]{8}$/)
  })
})

describe('落盘路径', () => {
  it('按 workspace 分子目录，文件名带卡号与第几次执行', () => {
    const path = recapRelativePath({ workspace: '/home/joe/vela', issueNumber: 12, runSeq: 3 })
    assert.match(path, /^runs\/vela-[0-9a-f]{8}\/12-r3\.md$/)
  })
})

describe('组装一篇 Recap', () => {
  it('刚落盘一律 draft，且 type 是唯一那一种', () => {
    const recap = readRecap(buildRecap({ facts: facts(), at: AT, velaVersion: '0.3.0' }))
    assert.equal(recap.status, 'draft')
    assert.equal(recap.type, RECAP_TYPE)
    assert.equal(recap.trust, 'unverified')
    assert.equal(recap.usageCount, 0)
  })

  it('标签里有 workspace、卡号与结果三项', () => {
    const recap = readRecap(buildRecap({ facts: facts(), at: AT, velaVersion: '0.3.0' }))
    assert.ok(recap.tags.some(tag => tag.startsWith('workspace:')), `实际标签：${recap.tags.join(' ')}`)
    assert.ok(recap.tags.includes('issue:12'))
    assert.ok(recap.tags.includes('outcome:completed'))
  })

  it('生成者写成 vela/<版本>，不是 Agent', () => {
    const text = buildRecap({ facts: facts(), at: AT, velaVersion: '0.3.0' })
    assert.match(text, /by: vela\/0\.3\.0/)
    assert.match(text, /usage_count: 0/)
  })

  it('Agent 交付的三段进正文', () => {
    const text = buildRecap({
      facts: facts(),
      delivery: { conclusion: '跑通了', did: '补了 6 个用例', pitfalls: '注意 position 会收敛' },
      at: AT,
      velaVersion: '0.3.0',
    })
    const body = readRecap(text).body
    assert.equal(sectionOf(body, '## 结论'), '跑通了')
    assert.equal(sectionOf(body, '## 做了什么'), '补了 6 个用例')
    assert.equal(sectionOf(body, '## 坑与注意'), '注意 position 会收敛')
  })

  it('没有交付时正文标注出来，不伪造内容', () => {
    const body = readRecap(buildRecap({ facts: facts(), at: AT, velaVersion: '0.3.0' })).body
    assert.match(sectionOf(body, '## 结论'), /没有交付收尾块/)
  })

  it('非成功收尾按原因分别标注', () => {
    const timeout = readRecap(buildRecap({ facts: facts({ outcome: 'timeout' }), at: AT, velaVersion: '0.3.0' }))
    assert.match(sectionOf(timeout.body, '## 结论'), /超时/)
    const interrupted = readRecap(buildRecap({
      facts: facts({ outcome: 'interrupted' }), at: AT, velaVersion: '0.3.0',
    }))
    assert.match(sectionOf(interrupted.body, '## 结论'), /结果未知/)
  })

  it('客观足迹段有文件与命令的明细', () => {
    const body = readRecap(buildRecap({ facts: facts(), at: AT, velaVersion: '0.3.0' })).body
    const section = sectionOf(body, '## 客观足迹')
    assert.match(section, /src\/domain\/ordering\.ts` 读 3 次、写 1 次/)
    assert.match(section, /pnpm test/)
    assert.match(section, /重复读文件：2 次/)
  })

  it('用量缺失时头部不写 0，正文显示未知', () => {
    // ADR-0011 的同一条态度：缺失表示未知，伪造成 0 会误导。
    const text = buildRecap({ facts: facts({ usage: undefined }), at: AT, velaVersion: '0.3.0' })
    assert.doesNotMatch(text, /input_tokens/)
    assert.match(sectionOf(readRecap(text).body, '## 客观足迹'), /用量：未知/)
    assert.equal(formatUsage(undefined), '未知')
  })

  it('召回事实只在真的召回过时才写', () => {
    const without = buildRecap({ facts: facts(), at: AT, velaVersion: '0.3.0' })
    assert.doesNotMatch(without, /recall_indexed/)
    const with_ = buildRecap({
      facts: facts({ recall: { indexed: 10, expanded: 2, injectedChars: 900, sourceChars: 6_000 } }),
      at: AT,
      velaVersion: '0.3.0',
    })
    assert.match(with_, /recall_indexed: 10/)
    assert.match(with_, /recall_expanded: 2/)
  })

  it('整篇能被自己读回来', () => {
    const text = buildRecap({
      facts: facts(),
      delivery: { conclusion: '好', did: '做了', pitfalls: '小心' },
      at: AT,
      velaVersion: '0.3.0',
    })
    const recap = readRecap(text)
    assert.equal(recap.title, '给 ordering 补测试')
    assert.equal(recap.staleAfter, '2026-11-15')
    assert.equal(recap.generatedAt, new Date(AT).toISOString())
    assert.equal(recap.verifiedAt, undefined)
  })

  it('status 写着不认识的值时按 draft 读，不当成已审', () => {
    // 宁可低估信任：把看不懂的状态读成「已稳定」会让未审的东西进召回。
    const recap = readRecap('---\ntype: Run Summary\nstatus: 我瞎写的\n---\n\n## 结论\n\n好\n')
    assert.equal(recap.status, 'draft')
  })
})

describe('从 Agent 回复里切收尾块', () => {
  /** 拼一个围栏块。 */
  function block(inner: readonly string[]): string {
    return ['```vela-recap', ...inner, '```'].join('\n')
  }

  it('三段都切出来', () => {
    const delivery = extractDelivery(`干完了。\n\n${block([
      '## 结论', '', '跑通了', '', '## 做了什么', '', '补了测试', '', '## 坑与注意', '', '无',
    ])}`)
    assert.equal(delivery?.conclusion, '跑通了')
    assert.equal(delivery?.did, '补了测试')
    assert.equal(delivery?.pitfalls, '无')
  })

  it('有多个块时取最后一个', () => {
    // 模型常先举例说明格式，真正的交付在最后。
    const text = [
      '我会按这个格式收尾：', block(['## 结论', '', '（示例）']),
      '开始干活……', block(['## 结论', '', '真的结论']),
    ].join('\n\n')
    assert.equal(extractDelivery(text)?.conclusion, '真的结论')
  })

  it('缺某一段时那一段是空串，其余照切', () => {
    const delivery = extractDelivery(block(['## 结论', '', '只有这一段']))
    assert.equal(delivery?.conclusion, '只有这一段')
    assert.equal(delivery?.did, '')
  })

  it('没有围栏块时给 undefined', () => {
    assert.equal(extractDelivery('我干完了，没有按格式写。'), undefined)
  })

  it('围栏块里三段全空时也给 undefined', () => {
    // 一个空块不算交付；上层会因此标注「这次没有交付收尾块」。
    assert.equal(extractDelivery(block(['', '随便说了句话', ''])), undefined)
  })

  it('波浪号围栏也认', () => {
    const delivery = extractDelivery('~~~vela-recap\n## 结论\n\n好\n~~~')
    assert.equal(delivery?.conclusion, '好')
  })

  it('没闭合的围栏按开到结尾处理', () => {
    // 模型输出被截断时很常见；宁可读到不完整的交付，也不要整篇丢掉。
    assert.equal(extractDelivery('```vela-recap\n## 结论\n\n被截断了')?.conclusion, '被截断了')
  })
})

describe('重复读文件的口径', () => {
  it('同一条路径第 2 次起算', () => {
    assert.equal(repeatedReadsOf([{ path: 'a', reads: 3, writes: 0 }]), 2)
  })

  it('只读一次不算重复', () => {
    assert.equal(repeatedReadsOf([{ path: 'a', reads: 1, writes: 0 }]), 0)
  })

  it('没读过（只写过）也不算', () => {
    assert.equal(repeatedReadsOf([{ path: 'a', reads: 0, writes: 2 }]), 0)
  })

  it('多个文件各算各的再求和', () => {
    assert.equal(repeatedReadsOf([
      { path: 'a', reads: 2, writes: 0 },
      { path: 'b', reads: 4, writes: 0 },
    ]), 1 + 3)
  })
})

describe('验收回写', () => {
  /** 一篇刚落盘的复盘。 */
  function fresh(): string {
    return buildRecap({
      facts: facts(),
      delivery: { conclusion: '跑通了', did: '补了测试', pitfalls: '无' },
      at: AT,
      velaVersion: '0.3.0',
    })
  }

  it('接受后文件里真的多出人审记录，等级升为 human-reviewed', () => {
    const recap = readRecap(markVerified(fresh(), OPERATOR_ACTOR, AT + 3_600_000))
    assert.equal(recap.trust, 'human-reviewed')
    assert.equal(recap.status, 'stable')
    assert.equal(recap.verifiedAt, new Date(AT + 3_600_000).toISOString())
  })

  it('同一个人重复回写不会追出第二条——对账会反复调它', () => {
    const once = markVerified(fresh(), OPERATOR_ACTOR, AT)
    const twice = markVerified(once, OPERATOR_ACTOR, AT + 10_000)
    assert.equal(twice.match(/by: human:operator/g)?.length, 1)
    assert.equal(twice, once)
  })

  it('换一个 actor 会追一条', () => {
    const text = markVerified(markVerified(fresh(), OPERATOR_ACTOR, AT), 'human:someone-else', AT)
    assert.equal(readRecap(text).trust, 'human-reviewed')
    assert.equal(text.match(/ {4}by: |  - by: /g)?.length, 2)
  })

  it('回写不动正文', () => {
    const before = readRecap(fresh()).body
    assert.equal(readRecap(markVerified(fresh(), OPERATOR_ACTOR, AT)).body, before)
  })

  it('标废弃只改状态，人审记录留着', () => {
    const verified = markVerified(fresh(), OPERATOR_ACTOR, AT)
    const recap = readRecap(markDeprecated(verified))
    assert.equal(recap.status, 'deprecated')
    assert.equal(recap.trust, 'human-reviewed')
  })
})

describe('引用计数', () => {
  it('展开一次加一，并更新最后修改时间', () => {
    const text = bumpUsageCount(buildRecap({ facts: facts(), at: AT, velaVersion: '0.3.0' }), AT + 1_000)
    const recap = readRecap(text)
    assert.equal(recap.usageCount, 1)
    assert.match(text, new RegExp(`last_modified: ${new Date(AT + 1_000).toISOString()}`))
  })

  it('加两次是 2', () => {
    let text = buildRecap({ facts: facts(), at: AT, velaVersion: '0.3.0' })
    text = bumpUsageCount(text, AT + 1_000)
    text = bumpUsageCount(text, AT + 2_000)
    assert.equal(readRecap(text).usageCount, 2)
  })

  it('别人的知识包没有 sources 时补一条，而不是把计数丢掉', () => {
    const text = bumpUsageCount('---\ntype: Run Summary\n---\n\n## 结论\n\n好\n', AT)
    assert.equal(readRecap(text).usageCount, 1)
  })
})
