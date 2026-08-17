/**
 * 创建小队的对话框。
 *
 * 参考 Multica 的创建弹窗：轻量、居中、只做**骨架**——名称加队长职责。队员
 * 刻意不放进来：每个队员要带能力白名单与后端，塞进弹窗会挤成一团。创建完进
 * 详情页再加（Multica 也是「附加成员，可选，也可稍后再加」的思路）。
 *
 * 编辑已有小队不走这里——那在详情页里改（详情页有 tab，空间够）。
 */

import { createElement, useEffect, useState } from 'react'

/** CreateSquadDialog 的 props。 */
export interface CreateSquadDialogProps {
  readonly busy: boolean
  /** 关掉（取消、点遮罩、Esc、或创建成功之后）。 */
  readonly onClose: () => void
  /** 提交骨架。名称与队长职责；队员创建后进详情再加。 */
  readonly onCreate: (input: { title: string; instruction: string }) => void
}

/** 创建小队的弹窗。 */
export function CreateSquadDialog(props: CreateSquadDialogProps): ReturnType<typeof createElement> {
  const { busy, onClose, onCreate } = props
  const [title, setTitle] = useState('')
  const [instruction, setInstruction] = useState('')

  const canSubmit = title.trim().length > 0 && !busy

  // Esc 关弹窗。挂在 window 上，因为焦点可能在任何一个输入框里。
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      // 捕获阶段拦截并阻止传播：BoardPanel 在 window 的冒泡阶段挂了一个全局
      // 「Esc 关面板」。不拦下的话，按一下 Esc 会连面板带弹窗一起关掉——
      // 而这下 Esc 的本意只是关弹窗。
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // onClose 只调 setCreateOpen(false)，setter 是稳定的，所以空依赖安全。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const submit = (): void => {
    if (!canSubmit) return
    onCreate({ title: title.trim(), instruction: instruction.trim() })
  }

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
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': '创建小队',
        // 点弹窗内部不穿透到遮罩（否则点输入框也会关）。
        onClick: (event: { stopPropagation(): void }) => event.stopPropagation(),
      },
      createElement(
        'header',
        { 'data-vela-modal-head': '' },
        createElement('strong', null, '创建小队'),
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
          '一个队长带若干队员：队长接到任务后自己拆活、派给队员。这里先建骨架，队员进去再加。'),
        createElement('label', { 'data-vela-modal-field': '' }, '小队名字',
          createElement('input', {
            value: title,
            placeholder: '例如：后端团队',
            autoFocus: true,
            onChange: (event: { target: { value: string } }) => setTitle(event.target.value),
            onKeyDown: (event: { key: string }) => { if (event.key === 'Enter') submit() },
          })),
        createElement('label', { 'data-vela-modal-field': '' }, '队长职责',
          createElement('textarea', {
            value: instruction,
            rows: 4,
            placeholder: '写清这支队负责什么、怎么拆活、什么算做完。',
            onChange: (event: { target: { value: string } }) => setInstruction(event.target.value),
          })),
      ),
      createElement(
        'footer',
        { 'data-vela-modal-foot': '' },
        createElement('button', { type: 'button', onClick: onClose }, '取消'),
        createElement('button', {
          type: 'button',
          'data-tone': 'primary',
          disabled: !canSubmit,
          onClick: submit,
        }, busy ? '创建中…' : '创建小队'),
      ),
    ),
  )
}
