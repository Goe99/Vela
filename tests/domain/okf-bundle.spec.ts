/**
 * 索引与更新历史的行为契约。
 *
 * 索引是可再生的派生物，所以这里只断言「摆出来的顺序与标记对不对」。更新
 * 历史是唯一重算不出来的东西，因此它的用例都围绕**不丢已有内容**。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  appendLogEntry, buildRootIndex, buildWorkspaceIndex, emptyLog, loggedLanded, loggedRemoved,
  readLogLines, trustMark,
} from '../../src/domain/okf-bundle.ts'
import type { BundleEntry, BundleGroup } from '../../src/domain/okf-bundle.ts'
import { parseDocument, readString } from '../../src/domain/okf-frontmatter.ts'

const AT = Date.parse('2026-08-17T09:30:00.000Z')

function entry(overrides: Partial<BundleEntry> = {}): BundleEntry {
  return {
    path: 'runs/vela-1a2b3c4d/12-r1.md',
    title: '给 ordering 补测试',
    trust: 'unverified',
    status: 'draft',
    stale: false,
    generatedAt: '2026-08-17T09:00:00.000Z',
    ...overrides,
  }
}

function group(entries: readonly BundleEntry[]): BundleGroup {
  return { slug: 'vela-1a2b3c4d', workspace: 'd:\\Code\\Items\\JCoder\\Vela', entries }
}

describe('根索引', () => {
  it('声明规范版本，好让别人认得这是个 OKF 知识包', () => {
    const text = buildRootIndex([group([entry()])], AT)
    assert.equal(readString(parseDocument(text).frontmatter, 'okf_version'), '0.2')
  })

  it('每个工作区一行，带篇数与人审过的篇数', () => {
    const text = buildRootIndex([group([
      entry(),
      entry({ path: 'runs/vela-1a2b3c4d/13-r1.md', trust: 'human-reviewed' }),
    ])], AT)
    assert.match(text, /\| 2 \| 1 \|/)
  })

  it('一篇都没有时明确说没有，而不是给一张空表', () => {
    assert.match(buildRootIndex([], AT), /还没有任何复盘/)
  })

  it('只到工作区一层就停——再往下是各自的索引', () => {
    // 这就是渐进披露：先给极小的一张目录，再决定展开哪一层。
    const text = buildRootIndex([group([entry()])], AT)
    assert.match(text, /\.\/runs\/vela-1a2b3c4d\/index\.md/)
    assert.doesNotMatch(text, /12-r1\.md/)
  })
})

describe('工作区索引', () => {
  it('人审过的排在前面', () => {
    // 索引就是召回时最先注入的东西，顺序即优先级。
    const text = buildWorkspaceIndex(group([
      entry({ title: '没审过的', generatedAt: '2026-08-17T10:00:00.000Z' }),
      entry({ title: '人审过的', trust: 'human-reviewed', generatedAt: '2026-08-01T10:00:00.000Z' }),
    ]), AT)
    assert.ok(text.indexOf('人审过的') < text.indexOf('没审过的'))
  })

  it('同样信任等级时新的在前', () => {
    const text = buildWorkspaceIndex(group([
      entry({ title: '旧的', generatedAt: '2026-08-01T10:00:00.000Z' }),
      entry({ title: '新的', generatedAt: '2026-08-17T10:00:00.000Z' }),
    ]), AT)
    assert.ok(text.indexOf('新的') < text.indexOf('旧的'))
  })

  it('废弃与陈旧都标出来', () => {
    const text = buildWorkspaceIndex(group([
      entry({ title: '废的', status: 'deprecated' }),
      entry({ title: '旧的', stale: true }),
    ]), AT)
    assert.match(text, /废的.*已废弃/)
    assert.match(text, /旧的.*已陈旧/)
  })

  it('空的工作区明确说空', () => {
    assert.match(buildWorkspaceIndex(group([]), AT), /还没有复盘/)
  })

  it('信任等级用文字而不是图标——索引也会被 Agent 读到', () => {
    assert.equal(trustMark('human-reviewed'), '人审过')
    assert.equal(trustMark('machine-confirmed'), '机器确认')
    assert.equal(trustMark('unverified'), '未验证')
  })
})

describe('更新历史', () => {
  it('从没有文件开始也能追加', () => {
    const text = appendLogEntry(undefined, loggedLanded('runs/x/1-r1.md', 1, 'completed'), AT)
    assert.match(text, /## 2026-08-17/)
    assert.match(text, /- 09:30 落下 `runs\/x\/1-r1\.md`/)
  })

  it('同一天的新条目插在这一天的最前面', () => {
    const first = appendLogEntry(undefined, '第一件事', AT)
    const second = appendLogEntry(first, '第二件事', AT + 3_600_000)
    const lines = readLogLines(second)
    assert.deepEqual(lines, ['10:30 第二件事', '09:30 第一件事'])
  })

  it('新的一天插在已有各天之前', () => {
    const day1 = appendLogEntry(undefined, '昨天的事', AT)
    const day2 = appendLogEntry(day1, '今天的事', AT + 86_400_000)
    assert.ok(day2.indexOf('## 2026-08-18') < day2.indexOf('## 2026-08-17'))
    assert.deepEqual(readLogLines(day2), ['09:30 今天的事', '09:30 昨天的事'])
  })

  it('已有内容一条都不会丢', () => {
    let text = emptyLog(AT)
    for (let day = 0; day < 5; day += 1) {
      text = appendLogEntry(text, `第 ${day} 件事`, AT + day * 86_400_000)
    }
    assert.equal(readLogLines(text).length, 5)
  })

  it('现有文件读不懂时抛错而不是覆盖', () => {
    // 更新历史是唯一重算不出来的东西；整份重写等于把「发生过什么」抹掉。
    assert.throws(() => appendLogEntry('这不是一份 OKF 文档', '新事', AT))
  })

  it('读条目时读不懂就给空数组，不抛给界面', () => {
    assert.deepEqual(readLogLines('乱码'), [])
  })

  it('删除也记一行，且写明是谁删的', () => {
    const text = appendLogEntry(undefined, loggedRemoved('runs/x/1-r1.md', 'human:operator'), AT)
    assert.match(text, /被 human:operator 删除/)
  })
})
