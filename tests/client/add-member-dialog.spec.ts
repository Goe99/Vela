/**
 * 加队员弹窗（AddMemberDialog）的渲染契约。
 *
 * 弹窗从详情页的内联展开改版而来：点「+ 加队员」开一个模态弹窗，里面 6 张
 * 角色模板卡 + 1 张空白队员卡，点卡即加。这里验结构；点按与 Esc 的交互由
 * 浏览器实测兜底（renderToStaticMarkup 不跑 effect，也点不了按钮）。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { AddMemberDialog } from '../../src/client/components/AddMemberDialog.tsx'
import { SquadDetail } from '../../src/client/components/SquadDetail.tsx'
import { ROLE_TEMPLATES } from '../../src/domain/role-templates.ts'

function renderDialog(): string {
  return renderToStaticMarkup(createElement(AddMemberDialog, {
    existingNames: [],
    memberCount: 0,
    onPick: () => undefined,
    onClose: () => undefined,
  }))
}

describe('AddMemberDialog', () => {
  it('是一个模态弹窗：遮罩 + dialog 语义 + 标题「加队员」', () => {
    const html = renderDialog()
    assert.ok(html.includes('data-vela-modal-backdrop'), '要有遮罩')
    assert.ok(html.includes('role="dialog"'))
    assert.ok(html.includes('aria-modal="true"'))
    assert.ok(html.includes('aria-label="加队员"'))
    assert.ok(html.includes('<strong>加队员</strong>'))
  })

  it('四种关闭方式的结构都在：X、遮罩、取消（Esc 靠 effect，浏览器实测兜底）', () => {
    const html = renderDialog()
    assert.ok(html.includes('aria-label="关闭"'), '右上 X')
    assert.ok(html.includes('>取消</button>'), '底部取消')
  })

  it('网格里是全部角色模板卡 + 一张空白队员卡', () => {
    const html = renderDialog()
    const cards = html.match(/data-vela-template-card/g) ?? []
    assert.equal(cards.length, ROLE_TEMPLATES.length + 1, '模板卡 + 空白卡')
    for (const template of ROLE_TEMPLATES) {
      assert.ok(html.includes(template.label), `缺模板卡：${template.label}`)
    }
    assert.ok(html.includes('空白队员'))
    assert.ok(html.includes('data-tone="blank"'), '空白卡要是虚线那张')
  })

  it('有一行提示，说清点卡即加、细节进详情页再改', () => {
    const html = renderDialog()
    assert.ok(html.includes('点一张卡直接加入小队'))
  })
})

describe('SquadDetail 的「+ 加队员」入口', () => {
  const squad = {
    id: 'vela-backend',
    title: 'backend',
    instruction: 'you lead.',
    members: [],
    maxParallelMembers: 2,
  }

  function renderDetail(): string {
    return renderToStaticMarkup(createElement(SquadDetail, {
      squad,
      platform: 'linux',
      modelCatalog: [],
      sandboxPresets: [],
      busy: false,
      onBack: () => undefined,
      onSave: () => undefined,
      onDelete: () => undefined,
    }))
  }

  it('按钮恒定是「+ 加队员」，不再有「收起」态', () => {
    const html = renderDetail()
    assert.ok(html.includes('+ 加队员'))
    assert.ok(!html.includes('收起'), '内联展开已移除，按钮不该再切收起态')
  })

  it('默认不渲染模板网格——它搬进弹窗了，不再内联顶开详情页', () => {
    const html = renderDetail()
    assert.ok(!html.includes('data-vela-template-grid'), '模板网格不该出现在详情页里')
    assert.ok(!html.includes('aria-expanded'), '不再是展开/收起交互')
  })
})
