/**
 * 模型清单的行为契约。
 *
 * 清单存在的意义是「让人挑，不让人背模型名」。所以这里钉的不是「能拉到」，
 * 而是失败时的形状：单个 provider 离线不该拖垮整份清单，全失败时留旧的，
 * 一份略旧的清单比一份空清单有用。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ModelCatalog } from '../src/model-catalog.ts'
import type { LlmServiceLike } from '../src/dsh.ts'

/** 可编排的假 llm 服务。 */
function fakeLlm(spec: Record<string, readonly { id: string; name: string }[] | Error>): LlmServiceLike & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    listProviders: () => Object.keys(spec).map(id => ({ id, name: id.toUpperCase() })),
    listModels: (provider: string) => {
      calls.push(provider)
      const entry = spec[provider]
      if (entry instanceof Error) return Promise.reject(entry)
      return Promise.resolve(entry ?? [])
    },
  }
}

describe('ModelCatalog', () => {
  it('把多个 provider 的模型摊成一张选项表，值是 provider/model', async () => {
    const catalog = new ModelCatalog(fakeLlm({
      deepseek: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }, { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' }],
      openai: [{ id: 'gpt-5', name: 'GPT-5' }],
    }))
    await catalog.refresh()
    assert.deepEqual(
      catalog.options.map(option => option.value),
      ['deepseek/deepseek-chat', 'deepseek/deepseek-reasoner', 'openai/gpt-5'],
    )
    assert.equal(catalog.options[0]?.label, 'DeepSeek Chat（DEEPSEEK）')
  })

  it('初始是空表——没刷新过时前端退化为手输', () => {
    const catalog = new ModelCatalog(fakeLlm({}))
    assert.equal(catalog.options.length, 0)
  })

  it('一个 provider 失败只跳过它，不拖垮整份清单', async () => {
    const catalog = new ModelCatalog(fakeLlm({
      deepseek: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }],
      offline: new Error('connection refused'),
    }))
    await catalog.refresh()
    assert.deepEqual(catalog.options.map(option => option.value), ['deepseek/deepseek-chat'])
  })

  it('全部失败时保留旧缓存——一份略旧的清单比一份空清单有用', async () => {
    const llm = fakeLlm({ deepseek: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] })
    const catalog = new ModelCatalog(llm)
    await catalog.refresh()
    assert.equal(catalog.options.length, 1)
    // 下一轮全挂了：缓存不动。
    llm.listModels = () => Promise.reject(new Error('all down'))
    await catalog.refresh()
    assert.equal(catalog.options.length, 1, '全失败不该把已有的清单清空')
  })
})
