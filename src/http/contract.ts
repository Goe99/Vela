/**
 * host 与 client 共享的 HTTP 契约常量。刻意是零依赖叶子模块：client
 * bundle 会 import 它，因此它不能顺藤摸到任何 node-only 代码。
 */

/** Vela 全部路由的前缀。 */
export const API_PREFIX = '/api/vela'
