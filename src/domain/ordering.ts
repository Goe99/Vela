/**
 * 分数索引排序（ADR-0006 / 票 06）。同 Lane 内按 position 升序排列，
 * 一次拖拽只改被拖动那一张卡片的 position——**不重排整列**，否则每次
 * 拖动都要重写 Lane 内所有 Issue，快照抖动且并发写更难。
 *
 * 代价是浮点精度有限：反复往同一缝隙插入会让相邻 position 收敛到无法
 * 再取中点。此时 `positionBetween` 返回 null，调用方必须重整该 Lane
 * （`renumber`），这是刻意暴露给调用方的边界而不是静默降级。
 */

/** 相邻两个 position 之间可以再插入的最小间隔。 */
const MIN_GAP = 1e-9

/** 新卡片落在一列末尾时的 position。空列从 1 开始。 */
export function positionForEnd(positions: readonly number[]): number {
  if (positions.length === 0) return 1
  return Math.max(...positions) + 1
}

/** 新卡片落在一列开头时的 position。空列从 1 开始。 */
export function positionForStart(positions: readonly number[]): number {
  if (positions.length === 0) return 1
  return Math.min(...positions) - 1
}

/**
 * 求两个 position 之间的中点。
 * @param before - 落点之前那张卡片的 position；落在列首时为 undefined。
 * @param after - 落点之后那张卡片的 position；落在列尾时为 undefined。
 * @returns 中点，或 null 表示精度已耗尽、调用方必须先重整该列。
 */
export function positionBetween(before: number | undefined, after: number | undefined): number | null {
  if (before === undefined && after === undefined) return 1
  if (before === undefined) return after! - 1
  if (after === undefined) return before + 1
  if (after - before <= MIN_GAP) return null
  const mid = (before + after) / 2
  // 浮点在极小间隔上会把中点吸附到端点：那已经等于没有插入空间。
  if (mid <= before || mid >= after) return null
  return mid
}

/**
 * 把一列重新编号为 1..n，保持现有相对次序。仅在 `positionBetween`
 * 返回 null 后调用。
 * @param ids - 该列的 id，已按目标次序排列。
 * @returns id 到新 position 的映射。
 */
export function renumber(ids: readonly string[]): ReadonlyMap<string, number> {
  return new Map(ids.map((id, index) => [id, index + 1]))
}

/** 按 position 升序、同值时按 id 稳定排序。 */
export function byPosition<T extends { readonly id: string; readonly position: number }>(a: T, b: T): number {
  if (a.position !== b.position) return a.position - b.position
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}
