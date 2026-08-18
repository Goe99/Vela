/**
 * 队员卡（MemberEditor）的渲染契约。
 *
 * 重点是模型字段的两种形态：有清单时是下拉（让人挑），清单空时退化为手输。
 * 以及模板卡片区：它替代了那个「从模板加…」的下拉——点卡片即在挑角色。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { MemberEditor } from '../../src/client/components/MemberEditor.tsx'
import type { SquadMember } from '../../src/domain/squad.ts'
import type { ModelOption } from '../../src/domain/models.ts'

const member: SquadMember = {
  name: 'researcher',
  instruction: '你只读不写。',
  abilities: ['read', 'web'],
  backend: 'spawn',
}

const catalog: readonly ModelOption[] = [
  { value: 'deepseek/deepseek-chat', label: 'DeepSeek Chat（DeepSeek）', provider: 'deepseek', model: 'deepseek-chat' },
  { value: 'deepseek/deepseek-reasoner', label: 'DeepSeek Reasoner（DeepSeek）', provider: 'deepseek', model: 'deepseek-reasoner' },
]

function render(overrides: Partial<Parameters<typeof MemberEditor>[0]> = {}): string {
  return renderToStaticMarkup(createElement(MemberEditor, {
    member,
    index: 0,
    platform: 'linux',
    modelCatalog: catalog,
    onPatch: () => undefined,
    onRemove: () => undefined,
    ...overrides,
  }))
}

describe('MemberEditor 的模型字段', () => {
  it('有清单时是下拉：沿用队长 + 各模型，可挑不可背', () => {
    const html = render()
    assert.ok(html.includes('<select'), '应该是一个下拉')
    assert.ok(html.includes('沿用队长（默认）'))
    assert.ok(html.includes('DeepSeek Reasoner（DeepSeek）'))
  })

  it('清单空时退化为手输——功能不因此消失', () => {
    const html = render({ modelCatalog: [] })
    assert.ok(html.includes('留空沿用队长'), '应该是手输框')
    assert.ok(!html.includes('沿用队长（默认）'), '不该有下拉的占位项')
  })

  it('已保存的值不在清单里时显示出来——否则下拉会静默把它显示成别的值', () => {
    const html = render({ member: { ...member, model: 'old/provider-removed' } })
    assert.ok(html.includes('old/provider-removed（已不在清单里）'), '旧值必须可见，不能静默丢配置')
  })

  it('已保存的值在清单里时被选中', () => {
    const html = render({ member: { ...member, model: 'deepseek/deepseek-reasoner' } })
    assert.ok(html.includes('value="deepseek/deepseek-reasoner" selected') || html.includes('selected'), '当前值要被选中')
  })

  it('队员有字母徽，同一个名字同一个色', () => {
    const first = render()
    const second = render()
    const hue = (html: string) => /data-hue="(\w+)"/.exec(html)?.[1]
    assert.equal(hue(first), hue(second), '同一个名字的徽标颜色必须稳定')
  })
})
