/**
 * 分数索引的行为契约。这些是纯函数，主接缝（HTTP）也会覆盖同样的行为；
 * 这里单独测是因为**精度耗尽**这个边界从 HTTP 面很难驱动到。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  byPosition, positionBetween, positionForEnd, positionForStart, renumber,
} from '../../src/domain/ordering.ts'

describe('positionForEnd', () => {
  it('空列从 1 开始', () => {
    assert.equal(positionForEnd([]), 1)
  })

  it('落在当前最大值之后', () => {
    assert.equal(positionForEnd([1, 2, 5]), 6)
  })

  it('不假设入参有序', () => {
    assert.equal(positionForEnd([5, 1, 2]), 6)
  })
})

describe('positionForStart', () => {
  it('空列从 1 开始', () => {
    assert.equal(positionForStart([]), 1)
  })

  it('落在当前最小值之前，允许为负', () => {
    assert.equal(positionForStart([1, 2]), 0)
    assert.equal(positionForStart([0]), -1)
  })
})

describe('positionBetween', () => {
  it('两侧皆空时给 1', () => {
    assert.equal(positionBetween(undefined, undefined), 1)
  })

  it('落在列首时取后继之前', () => {
    assert.equal(positionBetween(undefined, 3), 2)
  })

  it('落在列尾时取前驱之后', () => {
    assert.equal(positionBetween(3, undefined), 4)
  })

  it('取严格中点', () => {
    assert.equal(positionBetween(1, 2), 1.5)
    assert.equal(positionBetween(1, 4), 2.5)
  })

  it('反复对折仍然落在两端之间', () => {
    let before = 1
    const after = 2
    for (let i = 0; i < 40; i += 1) {
      const mid = positionBetween(before, after)
      if (mid === null) return // 已耗尽，另有专门用例覆盖
      assert.ok(mid > before, `第 ${i} 次对折应严格大于前驱`)
      assert.ok(mid < after, `第 ${i} 次对折应严格小于后继`)
      before = mid
    }
  })

  it('精度耗尽时返回 null 而不是静默返回端点', () => {
    // 连续对折直到无法再插入：必须显式返回 null，让调用方去重整。
    let before = 1
    const after = 2
    let exhausted = false
    for (let i = 0; i < 200; i += 1) {
      const mid = positionBetween(before, after)
      if (mid === null) { exhausted = true; break }
      before = mid
    }
    assert.ok(exhausted, '连续对折最终必须报告精度耗尽')
  })

  it('间隔已小于阈值时直接返回 null', () => {
    assert.equal(positionBetween(1, 1 + 1e-12), null)
  })

  it('两端相等时返回 null', () => {
    assert.equal(positionBetween(2, 2), null)
  })
})

describe('renumber', () => {
  it('按给定次序重排为 1..n', () => {
    const result = renumber(['c', 'a', 'b'])
    assert.equal(result.get('c'), 1)
    assert.equal(result.get('a'), 2)
    assert.equal(result.get('b'), 3)
  })

  it('空列返回空映射', () => {
    assert.equal(renumber([]).size, 0)
  })

  it('重整后相邻缝隙重新可插入', () => {
    const result = renumber(['a', 'b'])
    const mid = positionBetween(result.get('a'), result.get('b'))
    assert.ok(mid !== null && mid > 1 && mid < 2)
  })
})

describe('byPosition', () => {
  it('按 position 升序', () => {
    const items = [
      { id: 'b', position: 2 },
      { id: 'a', position: 1 },
    ]
    assert.deepEqual([...items].sort(byPosition).map(i => i.id), ['a', 'b'])
  })

  it('position 相同时按 id 稳定排序', () => {
    const items = [
      { id: 'z', position: 1 },
      { id: 'a', position: 1 },
    ]
    assert.deepEqual([...items].sort(byPosition).map(i => i.id), ['a', 'z'])
  })
})
