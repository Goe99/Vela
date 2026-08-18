/**
 * 模型清单的装配层：把宿主的 `ctx.llm` 变成一份可以随时同步读的选项表。
 *
 * `listModels` 是异步且可能走网络的，而看板视图是同步拼的——所以清单在后台
 * 定期刷新进缓存，接口永远只读缓存。代价写在明处：新接入的模型最多过
 * 一个刷新周期才出现在下拉里。
 */

import type { LlmServiceLike } from './dsh.ts'
import type { ModelOption } from './domain/models.ts'
import { modelOptionsOf } from './domain/models.ts'

/** 清单的缓存装配。 */
export class ModelCatalog {
  private cache: readonly ModelOption[] = []

  constructor(
    private readonly llm: LlmServiceLike,
    private readonly log?: (message: string) => void,
  ) {}

  /** 当前清单。没刷新过、或刷新全失败时是空表——前端据此退化为手输。 */
  get options(): readonly ModelOption[] {
    return this.cache
  }

  /**
   * 拉一轮。单个 provider 失败只跳过它——一个 provider 离线不该让整份清单消失。
   * 全部失败时保留旧缓存：一份略旧的清单比一份空清单有用。
   */
  async refresh(): Promise<void> {
    const next: ModelOption[] = []
    let succeeded = 0
    for (const provider of this.llm.listProviders()) {
      try {
        const models = await this.llm.listModels(provider.id)
        next.push(...modelOptionsOf(provider.id, provider.name, models))
        succeeded += 1
      } catch (error) {
        this.log?.(`vela: 拉取 ${provider.id} 的模型清单失败：${String(error)}`)
      }
    }
    if (succeeded > 0) this.cache = next
  }
}
