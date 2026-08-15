/**
 * 建卡表单（票 04），住在 Backlog 列顶部——新 Issue 只进 Backlog（ADR-0012）。
 *
 * 同时承担票 13 的「一批待办一次落盘」：粘贴多行文本，每行一张卡片。这解决的是
 * 「和 Agent 聊出一批待办后不用逐条重打」这个痛点。
 */

import { createElement, useState } from 'react'
import type { BoardClient } from '../board-client.ts'

/** 建卡表单的 props。 */
export interface NewIssueFormProps {
  readonly client: BoardClient
  /** 预填的 Workspace：当前筛选中的那个，否则最近用过的那个。 */
  readonly defaultWorkspace: string
  readonly sandboxPresets: readonly string[]
  onChanged(): void | Promise<void>
  onError(message: string | undefined): void
}

/** 建卡表单。 */
export function NewIssueForm(props: NewIssueFormProps): ReturnType<typeof createElement> {
  const { client, onChanged, onError } = props
  const [open, setOpen] = useState(false)
  const [batch, setBatch] = useState(false)
  const [title, setTitle] = useState('')
  const [workspace, setWorkspace] = useState(props.defaultWorkspace)
  const [busy, setBusy] = useState(false)
  const [local, setLocal] = useState<string | undefined>(undefined)

  const reset = (): void => {
    setTitle('')
    setLocal(undefined)
  }

  const submit = async (): Promise<void> => {
    const path = workspace.trim()
    if (path.length === 0) {
      setLocal('Workspace 必填')
      return
    }
    // 批量模式下一行一张卡；空行忽略，免得粘贴时的尾随换行变成一张空卡。
    const titles = batch
      ? title.split('\n').map(line => line.trim()).filter(line => line.length > 0)
      : [title.trim()].filter(line => line.length > 0)
    if (titles.length === 0) {
      setLocal(batch ? '至少要有一行标题' : '标题必填')
      return
    }
    setBusy(true)
    onError(undefined)
    try {
      const result = batch || titles.length > 1
        ? await client.createBatch(path, titles)
        : await client.createIssue({ title: titles[0]!, workspace: path })
      if (!result.ok) {
        setLocal(result.message)
        return
      }
      reset()
      await onChanged()
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return createElement(
      'button',
      {
        type: 'button',
        onClick: () => { setOpen(true); setWorkspace(props.defaultWorkspace) },
        'aria-label': 'new issue',
      },
      '+ 新建',
    )
  }

  return createElement(
    'form',
    {
      'data-vela-form': '',
      onSubmit: (event: { preventDefault(): void }) => { event.preventDefault(); void submit() },
    },
    createElement(
      'div',
      { 'data-vela-card-meta': '' },
      createElement(
        'label',
        { style: { display: 'flex', gap: '4px', alignItems: 'center' } },
        createElement('input', {
          type: 'checkbox',
          checked: batch,
          style: { width: 'auto' },
          onChange: (event: { target: { checked: boolean } }) => setBatch(event.target.checked),
        }),
        '一行一张',
      ),
    ),
    batch
      ? createElement('textarea', {
        'aria-label': 'issue titles',
        placeholder: '每行一个待办\n粘贴聊出来的清单即可',
        value: title,
        rows: 5,
        onChange: (event: { target: { value: string } }) => setTitle(event.target.value),
      })
      : createElement('input', {
        'aria-label': 'issue title',
        placeholder: '标题',
        value: title,
        onChange: (event: { target: { value: string } }) => setTitle(event.target.value),
      }),
    createElement('input', {
      'aria-label': 'issue workspace',
      placeholder: 'Workspace 绝对路径',
      value: workspace,
      onChange: (event: { target: { value: string } }) => setWorkspace(event.target.value),
    }),
    ...(local === undefined ? [] : [createElement('div', { key: 'err', 'data-vela-error': '' }, local)]),
    createElement(
      'div',
      { 'data-vela-actions': '' },
      createElement('button', { type: 'submit', disabled: busy, 'data-tone': 'primary' }, '新建'),
      createElement('button', {
        type: 'button',
        disabled: busy,
        onClick: () => { setOpen(false); reset() },
      }, '收起'),
    ),
  )
}
