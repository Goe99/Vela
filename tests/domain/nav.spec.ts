/**
 * 导航归属表的契约（ADR-0020）。
 *
 * 这里锁的是**结构**——十二项、三组、每项都有明确归属、置灰的两种原因分得开。
 * 刻意**不锁**具体的跳转目标：那会随 DSH 变化，锁死它只会制造无意义的失败。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  NAV_GROUPS, NAV_GROUP_LABELS, NAV_ITEMS, itemsInGroup, viewFor,
} from '../../src/domain/nav.ts'

describe('导航归属表', () => {
  it('十三项：Multica 的十二项加 Vela 自己的记忆页', () => {
    // 破例记在 ADR-0024：记忆库在 DSH 里不存在，不属于「不重画 DSH 已有界面」
    // 要防的情形；而一个 Operator 找不到入口的功能等于没做。
    assert.equal(NAV_ITEMS.length, 13)
  })

  it('沿用 Multica 的键名与顺序，方便逐项对照', () => {
    assert.deepEqual(NAV_ITEMS.map(item => item.key), [
      'inbox', 'chat', 'myIssues',
      'issues', 'projects', 'autopilots', 'agents', 'squads', 'memory', 'usage',
      'runtimes', 'skills', 'settings',
    ])
  })

  it('三个分组都有标题，且每组都非空', () => {
    assert.deepEqual([...NAV_GROUPS], ['personal', 'workspace', 'configure'])
    for (const group of NAV_GROUPS) {
      assert.ok(NAV_GROUP_LABELS[group].length > 0, `${group} 要有标题`)
      assert.ok(itemsInGroup(group).length > 0, `${group} 不能是空组`)
    }
  })

  it('每一项都有明确归属，没有一项悬空——这是 ADR-0020 的核心要求', () => {
    const known = ['view', 'close-panel', 'open-document', 'disabled']
    for (const item of NAV_ITEMS) {
      assert.ok(item.label.length > 0, `${item.key} 要有文案`)
      assert.ok(known.includes(item.action.kind), `${item.key} 的归属 ${item.action.kind} 不在已知种类里`)
    }
  })

  it('每一项的键唯一', () => {
    assert.equal(new Set(NAV_ITEMS.map(item => item.key)).size, NAV_ITEMS.length)
  })

  it('置灰的项必须写明原因，且两种原因分得开', () => {
    const disabled = NAV_ITEMS.filter(item => item.action.kind === 'disabled')
    assert.ok(disabled.length > 0, '应当有置灰项')
    for (const item of disabled) {
      if (item.action.kind !== 'disabled') throw new Error('unreachable')
      assert.ok(item.action.note.length > 0, `${item.key} 的置灰要写原因`)
    }
    // 技能曾经是「DSH 没有这个页面可去」的置灰位；现在 Vela 自己画技能广场，
    // 它必须是一个真视图而不是置灰项。
    const skills = NAV_ITEMS.find(item => item.key === 'skills')
    assert.equal(skills?.action.kind, 'view')
    if (skills?.action.kind === 'view') assert.equal(skills.action.view, 'skills')

    for (const key of ['projects', 'autopilots', 'usage']) {
      const item = NAV_ITEMS.find(candidate => candidate.key === key)
      assert.equal(item?.action.kind, 'disabled', `${key} 应置灰`)
      if (item?.action.kind === 'disabled') {
        assert.equal(item.action.reason, 'not-yet', `${key} 的原因应是「还没做」`)
      }
    }
  })

  it('只有「待你处理」带徽标', () => {
    const badged = NAV_ITEMS.filter(item => item.badge !== undefined)
    assert.deepEqual(badged.map(item => item.key), ['inbox'])
    assert.equal(badged[0]?.badge, 'attention')
  })

  it('Vela 自己画的视图恰好是 Board、待你处理、小队、技能、记忆五处', () => {
    const views = new Set(NAV_ITEMS.map(viewFor).filter(view => view !== undefined))
    assert.deepEqual([...views].sort(), ['attention', 'board', 'memory', 'skills', 'squads'])
  })

  it('聊天是「关掉自己的面板」而不是某种跳转——DSH 没有编程式切页', () => {
    const chat = NAV_ITEMS.find(item => item.key === 'chat')
    assert.equal(chat?.action.kind, 'close-panel')
  })

  it('能打开配置文件的项都指向真实存在的目标', () => {
    const targets = NAV_ITEMS
      .map(item => (item.action.kind === 'open-document' ? item.action.target : undefined))
      .filter(target => target !== undefined)
    assert.ok(targets.length > 0)
    for (const target of targets) {
      assert.ok(['settings', 'agent-presets'].includes(target), `${target} 不是已知的配置文件`)
    }
  })
})
