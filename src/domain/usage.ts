/**
 * Token 用量的折叠（票 10 / ADR-0011）。纯函数：给定一串会话事件，产出
 * 确定的用量总计。
 *
 * 用量住在 `assistant/message` 事件的 `usage` 字段上。DSH 那边只有
 * inputTokens 与 outputTokens 是必填，其余三项可选，因此缺失的项按
 * **跳过**处理而不是计为 0——两者在语义上不同：一条没有 usage 的事件是
 * 「这条消息没报用量」，不是「这条消息花了 0 token」。
 *
 * 计费口径：DSH 的三类输入计数是**互斥**的，因此计费输入是
 * inputTokens + cacheReadTokens + cacheWriteTokens 之和，不要把
 * inputTokens 当作已含缓存的总量再加一次。
 */

import type { TokenUsage } from './types.ts'

/** 全零用量。 */
export function zeroUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  }
}

/** 两份用量相加。 */
export function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
  }
}

/** 计费输入 token：三类互斥输入之和。 */
export function billedInputTokens(usage: TokenUsage): number {
  return usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
}

/** 一次 Run 的总 token：计费输入 + 输出。推理 token 已含在输出里，不再加。 */
export function totalTokens(usage: TokenUsage): number {
  return billedInputTokens(usage) + usage.outputTokens
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * 从一个未知形状的 usage 载荷里读出用量。返回 undefined 表示这条载荷
 * 根本没带用量——调用方据此跳过，而不是累加一份全零。
 */
export function readUsage(payload: unknown): TokenUsage | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const raw = payload as Record<string, unknown>
  const usage = raw.usage
  if (typeof usage !== 'object' || usage === null) return undefined
  const fields = usage as Record<string, unknown>
  const present = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']
    .some(key => typeof fields[key] === 'number')
  if (!present) return undefined
  return {
    inputTokens: count(fields.inputTokens),
    outputTokens: count(fields.outputTokens),
    cacheReadTokens: count(fields.cacheReadTokens),
    cacheWriteTokens: count(fields.cacheWriteTokens),
    reasoningTokens: count(fields.reasoningTokens),
  }
}

/** 一条待折叠的会话事件。只声明折叠用得到的字段。 */
export interface UsageEvent {
  readonly type: string
  readonly data?: unknown
}

/**
 * 折叠一串事件的总用量。返回 undefined 表示整段里没有任何一条报了用量
 * ——此时用量是**未知**，卡片上应显示未知而不是 0（ADR-0011）。
 */
export function foldUsage(events: Iterable<UsageEvent>): TokenUsage | undefined {
  let total: TokenUsage | undefined
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    const usage = readUsage(event.data)
    if (usage === undefined) continue
    total = total === undefined ? usage : addUsage(total, usage)
  }
  return total
}

/** 一个 Issue 的全部 Run 的累计用量。缺失用量的 Run 不参与累加。 */
export function sumUsage(usages: Iterable<TokenUsage | undefined>): TokenUsage | undefined {
  let total: TokenUsage | undefined
  for (const usage of usages) {
    if (usage === undefined) continue
    total = total === undefined ? usage : addUsage(total, usage)
  }
  return total
}
