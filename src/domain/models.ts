/**
 * 模型清单：这个部署实际接入了哪些模型。
 *
 * 给队员的「模型」字段做下拉用——让人挑，不让人背模型名。清单来自宿主的
 * `ctx.llm`（listProviders + listModels），Vela 只是把它摊平成一张选项表。
 */

/** 一个可选项：值直接就是队员 model 字段要的格式。 */
export interface ModelOption {
  /** 存进队员配置的值：`provider/model`。 */
  readonly value: string
  /** 下拉里显示的名字：模型名（provider 名）。 */
  readonly label: string
  readonly provider: string
  readonly model: string
}

/** 把一个 provider 的模型摊成选项。 */
export function modelOptionsOf(
  providerId: string,
  providerName: string,
  models: readonly { id: string; name: string }[],
): readonly ModelOption[] {
  return models.map(model => ({
    value: `${providerId}/${model.id}`,
    label: `${model.name}（${providerName}）`,
    provider: providerId,
    model: model.id,
  }))
}
