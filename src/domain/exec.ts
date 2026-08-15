/**
 * 执行配置的解析（票 11 / ADR-0010）。纯函数：Issue 上的覆盖值优先，未
 * 覆盖的项回落到插件配置里的全局默认。
 *
 * 全局默认属于配置而非源码常量——「改 README」与「改构建脚本」的权限档位
 * 天然不同，但每次派活弹对话框会毁掉一键派活的手感，所以默认值覆盖绝大
 * 多数卡片、其余在卡片上单独覆盖。
 */

import type { ExecOverrides } from './types.ts'

/** 一次执行的全局默认值。 */
export interface ExecDefaults {
  /** agent preset 名字；省略表示用 DSH 自己的有效默认。 */
  readonly agentPreset?: string
  /** 权限 preset 名字；省略表示不施加，沿用会话被创建时钉入的默认。 */
  readonly sandbox?: string
  /** 超时毫秒；0 或省略表示不限时。 */
  readonly timeoutMs?: number
}

/** 一次执行最终生效的配置。 */
export interface ResolvedExec {
  readonly agentPreset?: string
  readonly sandbox?: string
  /** 大于 0 才计时；0 表示不限时。 */
  readonly timeoutMs: number
}

/**
 * 解析一次执行的配置。
 * @param overrides - Issue 上的覆盖值。
 * @param defaults - 插件配置里的全局默认。
 * @returns 已解析的配置，可直接交给执行器。
 */
export function resolveExec(overrides: ExecOverrides, defaults: ExecDefaults): ResolvedExec {
  const agentPreset = overrides.agentPreset ?? defaults.agentPreset
  const sandbox = overrides.sandbox ?? defaults.sandbox
  const raw = overrides.timeoutMs ?? defaults.timeoutMs ?? 0
  const timeoutMs = Number.isFinite(raw) && raw > 0 ? raw : 0
  return {
    ...(agentPreset === undefined ? {} : { agentPreset }),
    ...(sandbox === undefined ? {} : { sandbox }),
    timeoutMs,
  }
}

/**
 * 校验一份覆盖值。返回一条错误说明，或 undefined 表示合法。
 *
 * sandbox 只能是宿主实际提供的 preset 名字之一。这条校验必须在**派活前**
 * 做掉：一个拼错的档位名会让 `permissionPresets.set` 抛错，那时会话已经
 * 建好、Agent 已经空转，收拾起来比拒绝一次配置贵得多。
 */
export function validateOverrides(
  overrides: ExecOverrides,
  availableSandboxes: readonly string[],
): string | undefined {
  if (overrides.sandbox !== undefined) {
    if (availableSandboxes.length === 0) {
      return 'this deployment provides no permission presets, so sandbox cannot be set'
    }
    if (!availableSandboxes.includes(overrides.sandbox)) {
      return `unknown sandbox preset "${overrides.sandbox}"; available: ${availableSandboxes.join(', ')}`
    }
  }
  if (overrides.timeoutMs !== undefined) {
    if (!Number.isFinite(overrides.timeoutMs) || overrides.timeoutMs < 0) {
      return 'timeoutMs must be a non-negative finite number'
    }
  }
  if (overrides.agentPreset !== undefined && overrides.agentPreset.trim().length === 0) {
    return 'agentPreset must not be blank'
  }
  return undefined
}
