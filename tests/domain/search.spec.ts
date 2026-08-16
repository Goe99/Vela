/**
 * Board 内搜索的语义（票 11）。
 *
 * 纯函数层，因此可以逐条钉住「什么算命中」。UI 那一侧只负责把结果铺回六列，
 * 那部分在 render 测试里。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { matchesQuery, searchIssues } from '../../src/domain/search.ts'
import type { Issue } from '../../src/domain/types.ts'

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: overrides.id ?? 'i1',
    number: overrides.number ?? 1,
    title: overrides.title ?? '接上支付回调',
    description: overrides.description ?? '',
    workspace: '/w',
    lane: 'todo',
    priority: 'none',
    position: 1,
    createdAt: 1,
    updatedAt: 1,
    maxAttempts: 0,
    exec: {},
    runs: [],
  }
}

describe('搜索：命中判据', () => {
  it('空查询命中一切', () => {
    assert.equal(matchesQuery(issue(), ''), true)
    assert.equal(matchesQuery(issue(), '   '), true)
  })

  it('标题子串命中，大小写不敏感', () => {
    assert.equal(matchesQuery(issue({ title: 'Fix Payment Webhook' }), 'payment'), true)
    assert.equal(matchesQuery(issue({ title: 'Fix Payment Webhook' }), 'PAYMENT'), true)
  })

  it('描述子串也命中——很多线索只写在描述里', () => {
    assert.equal(matchesQuery(issue({ title: '无关', description: '先验签再落库' }), '验签'), true)
  })

  it('编号可以只打数字，也可以带 V- 前缀', () => {
    const target = issue({ number: 12, title: '无关', description: '' })
    assert.equal(matchesQuery(target, '12'), true)
    assert.equal(matchesQuery(target, 'V-12'), true)
    assert.equal(matchesQuery(target, 'v-12'), true)
  })

  it('编号是精确匹配，不是子串——否则打 1 会捞出 1/10/11/100', () => {
    const target = issue({ number: 100, title: '无关', description: '' })
    assert.equal(matchesQuery(target, '1'), false)
    assert.equal(matchesQuery(target, '10'), false)
    assert.equal(matchesQuery(target, '100'), true)
  })

  it('纯数字仍然会去撞标题与描述的子串', () => {
    // 「打 1 找第 1 步」是对的：编号那条路走不通，文本这条路要走通。
    assert.equal(matchesQuery(issue({ number: 99, title: '第 1 步：建表' }), '1'), true)
  })

  it('查询前后的空白被忽略', () => {
    assert.equal(matchesQuery(issue({ number: 7, title: '无关' }), '  7  '), true)
  })

  it('都不匹配时返回 false', () => {
    assert.equal(matchesQuery(issue({ number: 3, title: '甲', description: '乙' }), '丙'), false)
  })
})

describe('搜索：过滤', () => {
  const cards = [
    issue({ id: 'a', number: 1, title: '登录页' }),
    issue({ id: 'b', number: 2, title: '支付回调', description: '验签' }),
    issue({ id: 'c', number: 3, title: '登录埋点' }),
  ]

  it('空查询原样返回同一个数组——不是副本', () => {
    // 这条路径每次轮询都会走。返回新数组会让下游 memo 全部失效，白白重渲看板。
    assert.equal(searchIssues(cards, ''), cards)
    assert.equal(searchIssues(cards, '   '), cards)
  })

  it('按标题收窄', () => {
    assert.deepEqual(searchIssues(cards, '登录').map(c => c.id), ['a', 'c'])
  })

  it('按编号收窄到一张', () => {
    assert.deepEqual(searchIssues(cards, 'V-2').map(c => c.id), ['b'])
  })

  it('按描述收窄', () => {
    assert.deepEqual(searchIssues(cards, '验签').map(c => c.id), ['b'])
  })

  it('无命中返回空数组', () => {
    assert.deepEqual(searchIssues(cards, '不存在的东西'), [])
  })

  it('保持原顺序——卡片仍待在它自己那一列的原位置上', () => {
    assert.deepEqual(searchIssues(cards, '登录').map(c => c.id), ['a', 'c'])
  })
})
