/**
 * Vela 领域类型。这一层**零 DSH 依赖**：Issue 的状态机与排序是纯业务，
 * 不该随 harness 的版本漂移而改。Run 只经 sessionId 指向一个 DSH 顶层
 * 会话（ADR-0003 / ADR-0013），执行侧的真相留在会话日志里，不复制过来。
 */

/** Board 的一列，恰好对应一个 Issue 状态。固定六个（ADR-0009）。 */
export type Lane =
  | 'backlog'
  | 'todo'
  | 'running'
  | 'review'
  | 'done'
  | 'failed'

/** 全部 Lane，按 Board 上从左到右的展示顺序。 */
export const LANES: readonly Lane[] = ['backlog', 'todo', 'running', 'review', 'done', 'failed']

/** Issue 的优先级。 */
export type Priority = 'none' | 'low' | 'medium' | 'high' | 'urgent'

/** 全部优先级，按由低到高。 */
export const PRIORITIES: readonly Priority[] = ['none', 'low', 'medium', 'high', 'urgent']

/** 一次 Run 的结束原因，映射 DSH 的 turn/end reason。 */
export type RunOutcome =
  | 'completed'
  | 'aborted'
  | 'blocked'
  | 'error'
  | 'max-tokens'
  | 'interrupted'
  | 'timeout'

/** Run 的生命周期状态。 */
export type RunStatus = 'running' | 'settled'

/**
 * Token 用量。字段与 DSH 的 TokenUsage 对齐且计数互斥——计费输入是
 * inputTokens + cacheReadTokens + cacheWriteTokens 之和，不要重复累加。
 */
export interface TokenUsage {
  /** 未命中缓存的输入。 */
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
}

/** 一次针对某个 Issue 的执行尝试。寿命短于它的 Issue。 */
export interface Run {
  readonly id: string
  /** 它执行所在的 DSH 顶层会话；Board 据此跳转（ADR-0013）。 */
  readonly sessionId: string
  readonly startedAt: number
  readonly status: RunStatus
  /** 仅在 settled 后存在。 */
  readonly endedAt?: number
  readonly outcome?: RunOutcome
  /** 失败详情，供卡片直接展示，免得 Operator 去翻会话。 */
  readonly failure?: string
  /**
   * Run 到达终态时聚合一次写入，此后不可变（ADR-0011）。缺失表示未知
   * ——异常终止时不要伪造成 0。
   */
  readonly usage?: TokenUsage
}

/** 一次执行的配置。未声明的项回落到全局默认（ADR-0010）。 */
export interface ExecOverrides {
  readonly agentPreset?: string
  /**
   * 派给哪支 Squad，值是 Squad 的 id。缺省 = 派单个 Agent。
   *
   * 一支 Squad 本质上就是一份 agent preset（ADR-0016），所以它和
   * `agentPreset` 最终作用到同一个旋钮上——两者**互斥**。分两个字段
   * 而不是共用 `agentPreset`，是因为「Operator 选了一支小队」与「Operator
   * 选了一份裸 preset」在行为上真的不同：前者要画并行时间轴、要发号牌
   * 限队员并发，后者两者都不适用。把区别存起来比从 preset 名字反推可靠。
   */
  readonly squad?: string
  /**
   * 权限 preset 的**名字**，不是 sandbox 档位取值。DSH 把权限建模为一张
   * 可配置的 preset 表，每项绑定一对 (sandbox, approval)；默认表里名字恰好
   * 与 sandbox 档位同名（workspace-write / danger-full-access），但部署可以
   * 改表，因此这里不写死联合类型，而是在派活前对着宿主实际提供的名字校验。
   */
  readonly sandbox?: string
  readonly timeoutMs?: number
}

/** Board 上的一张卡片。寿命长于它的任何一次 Run。 */
export interface Issue {
  readonly id: string
  /**
   * 稳定可引用的编号（`V-12` 里的 12）。在一份 Board 内单调递增且
   * **从不复用**——删掉一张卡后它的编号随之退役，否则“我刚说的 V-12”
   * 会在不同时间指向不同的事。计数器存在 Board 上，不从现有卡反推。
   */
  readonly number: number
  readonly title: string
  readonly description: string
  /** 被指派工作的代码库根目录（绝对路径）。 */
  readonly workspace: string
  readonly lane: Lane
  readonly priority: Priority
  /** 分数索引：同 Lane 内按此升序排列。 */
  readonly position: number
  readonly createdAt: number
  readonly updatedAt: number
  /** 自动重试上限。0 = 不自动重试（ADR-0010 的刻意默认值）。 */
  readonly maxAttempts: number
  readonly exec: ExecOverrides
  /** 历史 Run，按 startedAt 升序。 */
  readonly runs: readonly Run[]
}

/** 当前快照版本。版本 1 没有 Issue 编号，读取时自动补齐。 */
export const BOARD_VERSION = 2

/** Board 的完整快照——Vela 唯一拥有的持久状态。 */
export interface Board {
  readonly version: typeof BOARD_VERSION
  /**
   * 下一张卡要拿的编号。存下来而不从 `max(issues.number)` 反推，否则
   * 删掉最后一张卡后下一张会拿到同一个编号。
   */
  readonly nextNumber: number
  readonly issues: readonly Issue[]
}

/** 一个空 Board。 */
export function emptyBoard(): Board {
  return { version: BOARD_VERSION, nextNumber: 1, issues: [] }
}

/**
 * 编号的前缀。抽成常量因为搜索要反向认它（「V-12」与「12」得是同一个意图），
 * 而两处各写一份字面量早晚会分家。
 */
export const ISSUE_NUMBER_PREFIX = 'V-'

/** 编号的展示形式。单一出处，免得前后端各拼一份。 */
export function formatIssueNumber(value: number): string {
  return `${ISSUE_NUMBER_PREFIX}${value}`
}
