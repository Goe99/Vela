/**
 * 把一条 `turn/end` 事件解析成 Vela 的 Run 结局（票 09）。
 *
 * DSH 的结束原因是一个带 `kind` 的判别联合，error 分支还挂着 provider 的
 * 失败详情。这里是纯函数——把未知形状的载荷收窄成一个封闭的 RunOutcome
 * 加一句人能读的失败说明，好让卡片直接显示而不用 Operator 去翻会话。
 *
 * 遇到不认识的 kind 一律归为 error 而**不是** completed：把未知当成功会
 * 让 Issue 悄悄流进待验收，是最坏的失败模式。
 */

import type { RunOutcome } from './types.ts'

/** 一次结束的解析结果。 */
export interface RunEnd {
  readonly outcome: RunOutcome
  /** 失败说明；成功时为 undefined。 */
  readonly failure?: string
}

/** DSH 已知的结束原因 kind。 */
const KNOWN: Readonly<Record<string, RunOutcome>> = {
  'completed': 'completed',
  'aborted': 'aborted',
  'blocked': 'blocked',
  'error': 'error',
  'max-tokens': 'max-tokens',
  'interrupted': 'interrupted',
}

/** 每个失败结局的默认说明，供载荷没给细节时使用。 */
const DEFAULT_FAILURE: Readonly<Record<RunOutcome, string>> = {
  'completed': '',
  'aborted': '执行被取消',
  'blocked': '执行被阻塞',
  'error': '执行出错',
  'max-tokens': '达到 token 上限',
  'interrupted': '执行被中断',
  'timeout': '执行超时',
}

/** 这个结局对应的默认失败说明。 */
export function defaultFailure(outcome: RunOutcome): string {
  return DEFAULT_FAILURE[outcome]
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/**
 * 解析一条 `turn/end` 的 data 载荷。
 * @param data - 事件载荷，形状未经校验。
 * @returns 结局与失败说明；载荷完全无法辨认时归为 error。
 */
export function parseTurnEnd(data: unknown): RunEnd {
  const reason = typeof data === 'object' && data !== null
    ? (data as Record<string, unknown>).reason
    : undefined
  const kind = typeof reason === 'object' && reason !== null
    ? text((reason as Record<string, unknown>).kind)
    : undefined
  const outcome = kind === undefined ? 'error' : KNOWN[kind] ?? 'error'
  if (outcome === 'completed') return { outcome }

  // error 分支带 provider 失败详情；其余分支可能带一句 reason 文本。
  const detail = typeof reason === 'object' && reason !== null
    ? (reason as Record<string, unknown>)
    : undefined
  const error = detail?.error
  const parts: string[] = []
  if (typeof error === 'object' && error !== null) {
    const fields = error as Record<string, unknown>
    const code = text(fields.code)
    const message = text(fields.message)
    if (code !== undefined) parts.push(code)
    if (message !== undefined) parts.push(message)
  }
  const bare = text(detail?.reason)
  if (parts.length === 0 && bare !== undefined) parts.push(bare)
  if (kind !== undefined && KNOWN[kind] === undefined) parts.unshift(`未知结束原因 ${kind}`)
  const failure = parts.length === 0 ? DEFAULT_FAILURE[outcome] : parts.join(': ')
  return { outcome, failure }
}
