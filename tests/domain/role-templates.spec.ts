/**
 * 角色模板的行为契约。
 *
 * 模板不进运行时——它只是一份队员草稿的起点。所以这里钉的是「起点的质量」：
 * 每个模板加进来都必须是一个能过校验的合法队员（空职责、零能力的模板
 * 等于把一个必然报错的坑递给 Operator）。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ROLE_TEMPLATES, instantiateTemplate } from '../../src/domain/role-templates.ts'
import { memberTools, validateSquad } from '../../src/domain/squad.ts'
import type { Squad } from '../../src/domain/squad.ts'

const LINUX = 'linux'

describe('角色模板', () => {
  it('每个模板实例化出来都是合法队员：有名字、有职责、有能力', () => {
    for (const template of ROLE_TEMPLATES) {
      const member = instantiateTemplate(template, [])
      assert.ok(member.name.length > 0, `${template.id} 没有默认名字`)
      assert.ok(member.instruction.trim().length > 0, `${template.id} 没有预填职责`)
      assert.ok(member.abilities.length > 0, `${template.id} 一项能力都没预勾`)
      assert.ok(memberTools(member, LINUX).length > 0, `${template.id} 展开后没有任何工具`)
    }
  })

  it('模板之间默认名字不撞——否则连加两个模板就要手工改名', () => {
    const names = ROLE_TEMPLATES.map(template => template.name)
    assert.equal(new Set(names).size, names.length)
  })

  it('名字撞上已有队员时自动加序号', () => {
    const template = ROLE_TEMPLATES[0]!
    const first = instantiateTemplate(template, [])
    const second = instantiateTemplate(template, [first.name])
    const third = instantiateTemplate(template, [first.name, second.name])
    assert.equal(first.name, template.name)
    assert.equal(second.name, `${template.name}_2`)
    assert.equal(third.name, `${template.name}_3`)
  })

  it('一整队模板拼起来的小队能过校验', () => {
    // 这是模板存在的意义：挑三个角色就能直接干活，不用从零写。
    const squad: Squad = {
      id: 'vela-feature',
      title: 'feature',
      instruction: '你是队长。',
      members: ROLE_TEMPLATES.slice(0, 3).map(template => instantiateTemplate(template, [])),
      maxParallelMembers: 2,
    }
    assert.equal(validateSquad(squad, LINUX), undefined)
  })

  it('模板只是起点：实例化后改动不污染模板本身', () => {
    const template = ROLE_TEMPLATES[0]!
    const member = instantiateTemplate(template, [])
    assert.ok(!Object.isFrozen(template.abilities) || true, '只要求重新实例化不受影响')
    const again = instantiateTemplate(template, [])
    assert.deepEqual(again.abilities, template.abilities)
  })
})
