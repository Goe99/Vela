/**
 * Board 内搜索（票 11）：按编号、标题、描述找卡。
 *
 * 纯函数、不碰 React：搜索的语义（哪些算命中、`V-12` 怎么解）值得单独钉住，
 * 而在组件里测这些要绕过渲染。
 *
 * ## 为什么不排序
 *
 * 结果是**在六列里就地收窄**，不是一个扁平列表——卡片仍待在它原本那一列的原本
 * 位置上。因此「相关度排序」在这里没有落脚处：一张卡的位置由 Lane 与它在 Lane
 * 里的顺序决定，那是 Operator 自己排的，搜索不该动它。
 */

import type { Issue } from './types.ts'
import { ISSUE_NUMBER_PREFIX } from './types.ts'

/**
 * 一条查询能不能命中一张卡。
 *
 * 三条判据，取并集：
 *
 * 1. **编号**。`V-12`、`v-12`、`12` 都命中 12 号，因为 Operator 嘴上说的、
 *    复制粘贴的、以及顺手只打数字的，都是同一个意图。
 * 2. **标题**子串，大小写不敏感。
 * 3. **描述**子串，大小写不敏感。
 *
 * 编号是**精确**匹配而不是子串：输入 `1` 时把 1、10、11、100 全捞出来毫无用处。
 * 但纯数字同时也会去撞标题与描述的子串——那条路径上 `1` 匹配「第 1 步」是对的。
 */
export function matchesQuery(issue: Issue, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return true

  // 去掉可有可无的 `v-` 前缀再看是不是一个纯数字。
  const bare = needle.startsWith(ISSUE_NUMBER_PREFIX.toLowerCase())
    ? needle.slice(ISSUE_NUMBER_PREFIX.length)
    : needle
  if (/^\d+$/.test(bare) && Number(bare) === issue.number) return true

  if (issue.title.toLowerCase().includes(needle)) return true
  return issue.description.toLowerCase().includes(needle)
}

/**
 * 过滤出命中的卡。
 *
 * 空查询返回**传进来的那个数组本身**，不是一份副本：这条路径每次轮询都会走，
 * 返回新数组会让下游的 memo 全部失效，白白重渲整个看板。
 */
export function searchIssues(issues: readonly Issue[], query: string): readonly Issue[] {
  if (query.trim().length === 0) return issues
  return issues.filter(issue => matchesQuery(issue, query))
}
