/**
 * 召回的挑选与预算契约（ADR-0026 / 0027）。
 *
 * 这一层最要紧的一条是**候选集只有一种来源**：经 Gate 接受过的复盘。因此
 * 这里大半用例在证明「什么进不来」——草稿、废弃、陈旧、别的工作区、以及
 * 「自称 stable 却没有审核记录」的手改文件。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  RECALL_CHAR_BUDGET, RECALL_EXPAND_LIMIT, RECALL_INDEX_LIMIT,
  clipToParagraph, insightOf, selectRecall,
} from '../../src/domain/okf-recall.ts'
import type { RecallCandidate } from '../../src/domain/okf-recall.ts'

const NOW = Date.parse('2026-08-17T09:00:00.000Z')

/**
 * 可覆盖项。三个可选字段允许显式传 `undefined`：「没记工作区」与「没人审时间」
 * 都是真存在的情形（手改过的文件），测试必须能造出来。
 */
type CandidateOverrides = Partial<Omit<RecallCandidate, 'workspace' | 'staleAfter' | 'verifiedAt'>> & {
  readonly workspace?: string | undefined
  readonly staleAfter?: string | undefined
  readonly verifiedAt?: string | undefined
}

/** 一个合格的候选：同工作区、人审过、未废弃未陈旧。 */
function candidate(overrides: CandidateOverrides = {}): RecallCandidate {
  const merged = {
    path: 'runs/repo-1a2b3c4d/12-r1.md',
    title: '给 ordering 补测试',
    status: 'stable' as RecallCandidate['status'],
    trust: 'human-reviewed' as RecallCandidate['trust'],
    workspace: '/repo' as string | undefined,
    staleAfter: '2026-11-15' as string | undefined,
    verifiedAt: '2026-08-17T08:00:00.000Z' as string | undefined,
    body: '## 结论\n\n跑通了\n\n## 客观足迹\n\n- 结果：completed',
    ...overrides,
  }
  const { workspace, staleAfter, verifiedAt, ...rest } = merged
  return {
    ...rest,
    ...(workspace === undefined ? {} : { workspace }),
    ...(staleAfter === undefined ? {} : { staleAfter }),
    ...(verifiedAt === undefined ? {} : { verifiedAt }),
  }
}

describe('候选集只有一种来源', () => {
  it('人审过且 stable 的进得来', () => {
    assert.equal(selectRecall([candidate()], '/repo', NOW).indexed.length, 1)
  })

  it('草稿进不来', () => {
    assert.equal(selectRecall([candidate({ status: 'draft', trust: 'unverified' })], '/repo', NOW).indexed.length, 0)
  })

  it('废弃的进不来——它是反面证据，留着给人看而不是喂回去', () => {
    assert.equal(selectRecall([candidate({ status: 'deprecated' })], '/repo', NOW).indexed.length, 0)
  })

  it('陈旧的进不来', () => {
    const stale = candidate({ staleAfter: '2026-08-16' })
    assert.equal(selectRecall([stale], '/repo', NOW).indexed.length, 0)
  })

  it('别的工作区进不来——本轮不做跨工作区召回', () => {
    assert.equal(selectRecall([candidate({ workspace: '/other' })], '/repo', NOW).indexed.length, 0)
  })

  it('没记工作区的进不来：宁可漏，不可错喂', () => {
    assert.equal(selectRecall([candidate({ workspace: undefined })], '/repo', NOW).indexed.length, 0)
  })

  it('写着 stable 却没有审核记录的进不来', () => {
    // 一份手改过的文件可以自称稳定；「自称」不该被当成人审过。
    assert.equal(selectRecall([candidate({ trust: 'unverified' })], '/repo', NOW).indexed.length, 0)
  })

  it('机器确认的也进不来——本轮只认人审', () => {
    assert.equal(selectRecall([candidate({ trust: 'machine-confirmed' })], '/repo', NOW).indexed.length, 0)
  })

  it('一个候选都没有时文本是空的', () => {
    const recall = selectRecall([], '/repo', NOW)
    assert.equal(recall.text, '')
    assert.equal(recall.injectedChars, 0)
    assert.equal(recall.sourceChars, 0)
  })
})

describe('顺序与上限', () => {
  /** 造 n 篇，人审时间依次靠后。 */
  function many(count: number): readonly RecallCandidate[] {
    return Array.from({ length: count }, (_, at) => candidate({
      path: `runs/repo-1a2b3c4d/${at + 1}-r1.md`,
      title: `第 ${at + 1} 篇`,
      verifiedAt: `2026-08-${String(at + 1).padStart(2, '0')}T08:00:00.000Z`,
    }))
  }

  it('人审得越晚越靠前', () => {
    const recall = selectRecall(many(3), '/repo', NOW)
    assert.deepEqual(recall.indexed.map(item => item.title), ['第 3 篇', '第 2 篇', '第 1 篇'])
  })

  it('索引最多十篇', () => {
    assert.equal(selectRecall(many(25), '/repo', NOW).indexed.length, RECALL_INDEX_LIMIT)
  })

  it('正文最多展开两篇，其余只列标题', () => {
    const recall = selectRecall(many(5), '/repo', NOW)
    assert.equal(recall.expanded.length, RECALL_EXPAND_LIMIT)
    assert.equal(recall.indexed.length, 5)
  })

  it('没有人审时间的排在最后，但仍算候选', () => {
    const recall = selectRecall([
      candidate({ title: '没时间的', verifiedAt: undefined }),
      candidate({ title: '有时间的' }),
    ], '/repo', NOW)
    assert.deepEqual(recall.indexed.map(item => item.title), ['有时间的', '没时间的'])
  })
})

describe('注入的形状', () => {
  it('带明确标题，Operator 与 Agent 都能看出这段是 Vela 加的', () => {
    // ADR-0027：守的不是「不注入」，而是不偷偷注入。
    const recall = selectRecall([candidate()], '/repo', NOW)
    assert.match(recall.text, /^## 以前的经验/)
  })

  it('索引列标题与日期，展开的那些另附正文', () => {
    const recall = selectRecall([candidate({ title: '这一篇' })], '/repo', NOW)
    assert.match(recall.text, /- 这一篇（2026-08-17）/)
    assert.match(recall.text, /### 这一篇/)
    assert.match(recall.text, /跑通了/)
  })

  it('注入洞见，不注入账本', () => {
    // 客观足迹对 Operator 有用（可核对），对下一次执行没用，而它往往更长。
    const recall = selectRecall([candidate()], '/repo', NOW)
    assert.doesNotMatch(recall.text, /客观足迹/)
    assert.doesNotMatch(recall.text, /结果：completed/)
  })

  it('明说还有哪些只列了标题，好让 Agent 知道可以自己去读', () => {
    const recall = selectRecall([candidate(), candidate({ path: 'b.md' }), candidate({ path: 'c.md' })], '/repo', NOW)
    assert.match(recall.text, /其余只列了标题/)
  })
})

describe('预算', () => {
  /** 一篇很长的复盘。 */
  function long(chars: number, title = '长篇'): RecallCandidate {
    const paragraph = `${'字'.repeat(200)}\n\n`
    return candidate({
      title,
      body: `## 结论\n\n${paragraph.repeat(Math.ceil(chars / 202))}`,
    })
  }

  it('合计不超过预算', () => {
    const recall = selectRecall([long(5_000, 'A'), long(5_000, 'B')], '/repo', NOW)
    // 注入文本里除正文还有索引与说明，因此只断言正文那部分没有超预算。
    const bodies = recall.text.split('### ').slice(1).join('').length
    assert.ok(bodies <= RECALL_CHAR_BUDGET, `正文合计 ${bodies} 超过了 ${RECALL_CHAR_BUDGET}`)
  })

  it('超预算时截断并标注，而不是硬切在半句话上', () => {
    const recall = selectRecall([long(6_000)], '/repo', NOW)
    assert.match(recall.text, /（这篇已截断）/)
  })

  it('截断切在段落边界上', () => {
    // 预算要同时满足两件事：小于全文（否则不触发截断）、又宽到能装下
    // 「一个完整段落 + 截断标记」。全文 16 字，预算 15。
    const clipped = clipToParagraph('第一段落\n\n第二段落\n\n第三段落', 15)
    assert.equal(clipped, '第一段落\n\n（这篇已截断）')
  })

  it('一整段都放不下时宁可不放', () => {
    assert.equal(clipToParagraph('一个很长的段落没有任何分隔', 10), '')
  })

  it('放得下时原样返回，不加截断标记', () => {
    assert.equal(clipToParagraph('短', 100), '短')
  })

  it('压缩率的分母是索引里那几篇的全文', () => {
    // 要回答的是「不做渐进披露、把候选全文塞进去会是多少」。因此压缩只有在
    // 候选多于可展开数时才存在：此处 6 篇候选、只展开 2 篇，其余只占一行标题。
    const six = Array.from({ length: 6 }, (_, at) => candidate({
      path: `runs/repo-1a2b3c4d/${at + 1}-r1.md`,
      title: `第 ${at + 1} 篇`,
      body: 'x'.repeat(1_000),
    }))
    const recall = selectRecall(six, '/repo', NOW)
    assert.equal(recall.sourceChars, 6_000)
    assert.equal(recall.expanded.length, 2)
    assert.ok(recall.injectedChars < recall.sourceChars, `注入 ${recall.injectedChars} 应当少于全文 ${recall.sourceChars}`)
  })
})

describe('洞见的切法', () => {
  it('去掉客观足迹段，其余原样', () => {
    assert.equal(insightOf('## 结论\n\n好\n\n## 客观足迹\n\n- 一堆数字'), '## 结论\n\n好')
  })

  it('没有客观足迹段时整篇都是洞见', () => {
    assert.equal(insightOf('## 结论\n\n好'), '## 结论\n\n好')
  })
})
