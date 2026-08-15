/**
 * 六 Lane 状态机（ADR-0009）。Lane 不是标签而是状态机节点，因此迁移表
 * 是封闭的：非法落点必须在 drop 时被拒绝，而不是接受后回滚。
 *
 * 两类迁移分开建模，因为**权限不同**：
 * - Operator 拖拽：人的意图，但不能凭空进出 Running（那由 Run 驱动）。
 * - 系统事件：Run 的启动与结束，Operator 无法手动伪造。
 *
 * ADR-0007 的核心不变量：Run 结果**永远**无法把 Issue 推进 done——
 * 成功只到 review，终态由 Operator 在 Gate 上决定。
 */

import type { Lane } from './types.ts'

/** Operator 拖拽可达的迁移。 */
const OPERATOR_TRANSITIONS: Readonly<Record<Lane, readonly Lane[]>> = {
  // 两个未开始的 Lane 之间自由移动。
  backlog: ['todo'],
  todo: ['backlog'],
  // Running 期间有一个活的 Run，拖出去会让它成为孤儿。要停就取消 Run，
  // 由系统把它送去 failed——这样「running 意味着存在活 Run」始终成立。
  running: [],
  // Gate：接受进 done，退回进 todo，也允许直接搁置回 backlog。
  review: ['done', 'todo', 'backlog'],
  // 重开一个已完成的 Issue。
  done: ['todo', 'backlog'],
  // 失败后重排或搁置。刻意**不含 done**：绕过 Gate 宣布完成会掏空
  // ADR-0007 建立的把关点。
  failed: ['todo', 'backlog'],
}

/** 系统事件。 */
export type SystemEvent = 'run-started' | 'run-succeeded' | 'run-failed'

/** 系统事件可作用的源 Lane 与其目标。 */
const SYSTEM_TRANSITIONS: Readonly<Record<SystemEvent, { readonly from: readonly Lane[]; readonly to: Lane }>> = {
  // 派活：除了已经在跑的，任何 Lane 都可以起一个 Run。一个 Issue 同时
  // 只能有一个活 Run。
  'run-started': { from: ['backlog', 'todo', 'review', 'done', 'failed'], to: 'running' },
  // 关键不变量：成功只到 review，不到 done。
  'run-succeeded': { from: ['running'], to: 'review' },
  'run-failed': { from: ['running'], to: 'failed' },
}

/** Operator 能否把一张卡片从 `from` 拖到 `to`。 */
export function canOperatorMove(from: Lane, to: Lane): boolean {
  if (from === to) return true
  return OPERATOR_TRANSITIONS[from].includes(to)
}

/** Operator 从 `from` 可达的全部 Lane（供 UI 高亮合法落点）。 */
export function operatorTargets(from: Lane): readonly Lane[] {
  return OPERATOR_TRANSITIONS[from]
}

/** 一个系统事件作用于 `from` 时的目标 Lane；不适用则 undefined。 */
export function systemTarget(event: SystemEvent, from: Lane): Lane | undefined {
  const rule = SYSTEM_TRANSITIONS[event]
  return rule.from.includes(from) ? rule.to : undefined
}

/** 该 Lane 是否表示「有一个活的 Run」。 */
export function isActive(lane: Lane): boolean {
  return lane === 'running'
}

/** 该 Lane 是否是终态。 */
export function isTerminal(lane: Lane): boolean {
  return lane === 'done'
}
