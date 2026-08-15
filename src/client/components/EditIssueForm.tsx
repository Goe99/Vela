/**
 * 卡片的就地编辑表单（票 05/11）。除了标题、描述、Workspace、优先级，还承担
 * **单卡片的执行配置覆盖**：agent preset、权限档位、超时、自动重试上限。
 *
 * 覆盖项一律以「跟随全局默认」为默认选项——空值表示不覆盖，而不是覆盖成空。
 * 这让一键派活的手感保持不变：绝大多数卡片什么都不设。
 */

import { createElement, useState } from 'react'
import type { Issue, Priority } from '../../domain/types.ts'
import { PRIORITIES } from '../../domain/types.ts'
import type { BoardClient } from '../board-client.ts'

/** 编辑表单的 props。 */
export interface EditIssueFormProps {
  readonly issue: Issue
  readonly sandboxPresets: readonly string[]
  readonly client: BoardClient
  onDone(): void
  onCancel(): void
  onError(message: string | undefined): void
}

/** 「跟随全局默认」的哨兵值。 */
const INHERIT = ''

const PRIORITY_LABELS: Readonly<Record<Priority, string>> = {
  none: '无',
  low: '低',
  medium: '中',
  high: '高',
  urgent: '紧急',
}

/** 编辑表单。 */
export function EditIssueForm(props: EditIssueFormProps): ReturnType<typeof createElement> {
  const { issue, client, onDone, onCancel } = props
  const [title, setTitle] = useState(issue.title)
  const [description, setDescription] = useState(issue.description)
  const [workspace, setWorkspace] = useState(issue.workspace)
  const [priority, setPriority] = useState<Priority>(issue.priority)
  const [maxAttempts, setMaxAttempts] = useState(String(issue.maxAttempts))
  const [sandbox, setSandbox] = useState(issue.exec.sandbox ?? INHERIT)
  const [agentPreset, setAgentPreset] = useState(issue.exec.agentPreset ?? INHERIT)
  const [timeoutText, setTimeoutText] = useState(
    issue.exec.timeoutMs === undefined ? INHERIT : String(Math.round(issue.exec.timeoutMs / 1000)),
  )
  const [busy, setBusy] = useState(false)
  const [local, setLocal] = useState<string | undefined>(undefined)

  const submit = async (): Promise<void> => {
    if (title.trim().length === 0) {
      setLocal('标题必填')
      return
    }
    if (workspace.trim().length === 0) {
      setLocal('Workspace 必填')
      return
    }
    const attempts = Number(maxAttempts)
    if (!Number.isInteger(attempts) || attempts < 0) {
      setLocal('自动重试上限必须是非负整数')
      return
    }
    const seconds = timeoutText.trim() === INHERIT ? undefined : Number(timeoutText)
    if (seconds !== undefined && (!Number.isFinite(seconds) || seconds < 0)) {
      setLocal('超时必须是非负秒数')
      return
    }
    setBusy(true)
    setLocal(undefined)
    try {
      // 每个覆盖项：空值 = 不覆盖（回落到全局默认），因此发 null 而非空串。
      const result = await client.updateIssue(issue.id, {
        title: title.trim(),
        description,
        workspace: workspace.trim(),
        priority,
        maxAttempts: attempts,
        exec: {
          sandbox: sandbox === INHERIT ? null : sandbox,
          agentPreset: agentPreset.trim() === INHERIT ? null : agentPreset.trim(),
          timeoutMs: seconds === undefined ? null : Math.round(seconds * 1000),
        },
      })
      if (!result.ok) {
        setLocal(result.message)
        return
      }
      onDone()
    } finally {
      setBusy(false)
    }
  }

  const field = (label: string, control: ReturnType<typeof createElement>): ReturnType<typeof createElement> =>
    createElement('label', { key: label, style: { display: 'block' } },
      createElement('span', { 'data-vela-hint': '' }, label),
      control)

  return createElement(
    'form',
    {
      'data-vela-form': '',
      onSubmit: (event: { preventDefault(): void }) => { event.preventDefault(); void submit() },
    },
    field('标题', createElement('input', {
      'aria-label': 'edit title',
      value: title,
      onChange: (event: { target: { value: string } }) => setTitle(event.target.value),
    })),
    field('描述', createElement('textarea', {
      'aria-label': 'edit description',
      value: description,
      rows: 3,
      onChange: (event: { target: { value: string } }) => setDescription(event.target.value),
    })),
    field('Workspace', createElement('input', {
      'aria-label': 'edit workspace',
      value: workspace,
      onChange: (event: { target: { value: string } }) => setWorkspace(event.target.value),
    })),
    field('优先级', createElement(
      'select',
      {
        'aria-label': 'edit priority',
        value: priority,
        onChange: (event: { target: { value: string } }) => setPriority(event.target.value as Priority),
      },
      ...PRIORITIES.map(value => createElement('option', { key: value, value }, PRIORITY_LABELS[value])),
    )),
    field('自动重试上限（0 = 不自动重试）', createElement('input', {
      'aria-label': 'edit max attempts',
      type: 'number',
      min: 0,
      value: maxAttempts,
      onChange: (event: { target: { value: string } }) => setMaxAttempts(event.target.value),
    })),
    field('权限档位', createElement(
      'select',
      {
        'aria-label': 'edit sandbox',
        value: sandbox,
        onChange: (event: { target: { value: string } }) => setSandbox(event.target.value),
      },
      createElement('option', { key: INHERIT, value: INHERIT }, '跟随全局默认'),
      ...props.sandboxPresets.map(name => createElement('option', { key: name, value: name }, name)),
    )),
    field('agent preset（留空跟随默认）', createElement('input', {
      'aria-label': 'edit agent preset',
      value: agentPreset,
      placeholder: '跟随全局默认',
      onChange: (event: { target: { value: string } }) => setAgentPreset(event.target.value),
    })),
    field('超时秒数（留空 = 不限时）', createElement('input', {
      'aria-label': 'edit timeout seconds',
      type: 'number',
      min: 0,
      value: timeoutText,
      placeholder: '不限时',
      onChange: (event: { target: { value: string } }) => setTimeoutText(event.target.value),
    })),
    ...(local === undefined ? [] : [createElement('div', { key: 'err', 'data-vela-error': '' }, local)]),
    createElement(
      'div',
      { 'data-vela-actions': '' },
      createElement('button', { type: 'submit', disabled: busy, 'data-tone': 'primary' }, '保存'),
      createElement('button', { type: 'button', disabled: busy, onClick: onCancel }, '取消'),
    ),
  )
}
