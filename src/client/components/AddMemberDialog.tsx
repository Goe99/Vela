/**
 * 加队员的对话框。
 *
 * 结构沿用创建小队弹窗（CreateSquadDialog，Multica 移植体系）的 modal 基建：
 * 遮罩 + 居中弹窗 + 头/体/底，Esc 在捕获阶段拦截，免得连带关掉整个面板。
 * 形态参考 Qoder「新建 Waker」弹窗（遮罩压暗、角色卡片网格、四种关闭方式），
 * 但不做它的表单流——这里点卡即加，队员的名字/职责/能力加进来后在详情页改。
 *
 * 为什么从页面内联展开改成弹窗：内联展开把详情页内容往下顶，队员一多，
 * 模板区和队员列表互相挤压；挑角色是「专注做一件事」的场景，弹窗把它隔离开。
 */

import { createElement, useEffect } from 'react'
import type { SquadMember } from '../../domain/squad.ts'
import { ABILITY_LABELS } from '../../domain/squad.ts'
import { ROLE_TEMPLATES, instantiateTemplate } from '../../domain/role-templates.ts'
import { avatarChar, memberHue } from './MemberEditor.tsx'

/** AddMemberDialog 的 props。 */
export interface AddMemberDialogProps {
  /** 已有队员的名字，模板实例化时用来避开重名（engineer → engineer_2）。 */
  readonly existingNames: readonly string[]
  /** 已有队员数，给空白队员起默认名（member_N）用。 */
  readonly memberCount: number
  /** 点中某张卡：把实例化好的队员交出去。调用方负责加进草稿并关窗。 */
  readonly onPick: (member: SquadMember) => void
  /** 关掉（X、点遮罩、Esc、取消）。 */
  readonly onClose: () => void
}

/** 空白队员的默认骨架。 */
function newMember(index: number): SquadMember {
  return {
    name: `member_${index + 1}`,
    instruction: '',
    abilities: ['read'],
    backend: 'spawn',
  }
}

/** 加队员的弹窗：6 张角色模板卡 + 1 张空白队员卡，点卡即加。 */
export function AddMemberDialog(props: AddMemberDialogProps): ReturnType<typeof createElement> {
  const { onClose, onPick } = props

  // Esc 关弹窗。挂在 window 的捕获阶段并阻止传播：BoardPanel 在冒泡阶段挂了
  // 全局「Esc 关面板」，不拦下的话一下 Esc 会连面板带弹窗一起关掉——
  // 与 CreateSquadDialog 同一套写法。
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // onClose 只调 setDialogOpen(false)，setter 是稳定的，所以空依赖安全。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return createElement(
    'div',
    {
      'data-vela-modal-backdrop': '',
      onClick: onClose,
    },
    createElement(
      'div',
      {
        'data-vela-modal': '',
        'data-vela-add-member': '',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': '加队员',
        // 点弹窗内部不穿透到遮罩（否则点卡片之间的空隙也会关）。
        onClick: (event: { stopPropagation(): void }) => event.stopPropagation(),
      },
      createElement(
        'header',
        { 'data-vela-modal-head': '' },
        createElement('strong', null, '加队员'),
        createElement('button', {
          type: 'button',
          'data-vela-icon-btn': '',
          'aria-label': '关闭',
          onClick: onClose,
        }, '✕'),
      ),
      createElement(
        'div',
        { 'data-vela-modal-body': '' },
        createElement('p', { 'data-vela-hint': '' },
          '点一张卡直接加入小队——名字、职责、能力加进来后都能在队员卡里改。'),
        // 模板卡片网格：每张卡讲清三件事——叫什么、干什么、默认带哪些能力。
        // 最后一张是空白队员，从零自己写。
        createElement(
          'div',
          { 'data-vela-template-grid': '' },
          ...ROLE_TEMPLATES.map(template => createElement(
            'button',
            {
              key: template.id,
              type: 'button',
              'data-vela-template-card': '',
              onClick: () => onPick(instantiateTemplate(template, props.existingNames)),
            },
            createElement('span', { 'data-vela-template-head': '' },
              createElement('span', {
                'data-vela-avatar': '',
                'data-hue': String(memberHue(template.name)),
                'aria-hidden': 'true',
              }, avatarChar(template.name)),
              createElement('span', { 'data-vela-template-name': '' }, template.label),
              createElement('span', { 'data-vela-template-tool': '' }, template.name),
            ),
            createElement('span', { 'data-vela-template-blurb': '' }, template.blurb),
            createElement('span', { 'data-vela-template-abilities': '' },
              template.abilities.map(a => ABILITY_LABELS[a]).join(' · ')),
          )),
          createElement(
            'button',
            {
              key: '__blank',
              type: 'button',
              'data-vela-template-card': '',
              'data-tone': 'blank',
              onClick: () => onPick(newMember(props.memberCount)),
            },
            createElement('span', { 'data-vela-template-head': '' },
              createElement('span', { 'data-vela-template-plus': '', 'aria-hidden': 'true' }, '+'),
              createElement('span', { 'data-vela-template-name': '' }, '空白队员'),
            ),
            createElement('span', { 'data-vela-template-blurb': '' }, '从零写：名字、职责、能力都自己定'),
          ),
        ),
      ),
      createElement(
        'footer',
        { 'data-vela-modal-foot': '' },
        createElement('button', { type: 'button', onClick: onClose }, '取消'),
      ),
    ),
  )
}
