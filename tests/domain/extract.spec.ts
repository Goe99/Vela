/**
 * 从会话里挑候选待办的行为契约（票 13）。
 *
 * 这一层的两类错误代价不对称：漏掉一条真待办，Operator 得自己重打；多捞一条
 * 垃圾，Operator 只是不勾它。所以规则偏向宽松地捞，而下面这些用例钉的是
 * **不能捞进来的东西**——那才是会让候选清单变成噪音的部分。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { extractCandidates } from '../../src/domain/extract.ts'

/** 取出标题，测试里大多只关心这个。 */
function titles(texts: readonly string[]): readonly string[] {
  return extractCandidates(texts).map(candidate => candidate.title)
}

describe('认得出常见的清单写法', () => {
  it('短横线清单', () => {
    assert.deepEqual(titles(['- 修好登录页的报错\n- 给导出加个进度条']), [
      '修好登录页的报错', '给导出加个进度条',
    ])
  })

  it('星号与加号清单', () => {
    assert.deepEqual(titles(['* 补一份接口文档\n+ 清掉过期的开关']), [
      '补一份接口文档', '清掉过期的开关',
    ])
  })

  it('数字清单，点与括号都算', () => {
    assert.deepEqual(titles(['1. 先跑一遍回归\n2) 再合到主干\n（3）最后发版']), [
      '先跑一遍回归', '再合到主干', '最后发版',
    ])
  })

  it('编号标记后不加空格也算——中文习惯就是不加', () => {
    assert.deepEqual(titles(['1.先跑一遍回归\n（2）再合到主干']), [
      '先跑一遍回归', '再合到主干',
    ])
  })

  it('符号标记后必须有空格——否则行文里的减号会被当成列表', () => {
    assert.deepEqual(titles(['-减去两个字段就行了']), [])
  })

  it('未勾选的复选框，标记要去掉', () => {
    assert.deepEqual(titles(['- [ ] 把缓存换成新的键']), ['把缓存换成新的键'])
  })

  it('带缩进的子项也算——嵌套清单里的条目一样是待办', () => {
    assert.deepEqual(titles(['- 先把导出拆成两步\n  - 子项要单独排期']), [
      '先把导出拆成两步', '子项要单独排期',
    ])
  })
})

describe('不该捞进来的东西', () => {
  it('已经打勾的不算——它记录的是做完了，不是要做', () => {
    assert.deepEqual(titles(['- [x] 这条早做完了\n- [ ] 这条还没做']), ['这条还没做'])
  })

  it('围栏代码块里的清单行整段跳过', () => {
    // 真实场景：助手贴一段 YAML 或 shell，里面每行都以 `- ` 开头。
    const text = [
      '配置这样写：',
      '```yaml',
      '- name: 这不是待办',
      '- name: 这也不是',
      '```',
      '- 这条才是真待办',
    ].join('\n')
    assert.deepEqual(titles([text]), ['这条才是真待办'])
  })

  it('未闭合的围栏按一直开到结尾处理——宁可少捞', () => {
    // 模型输出被截断时很常见。要是按「未闭合就当没有围栏」处理，半个配置
    // 文件会变成一堆卡片。
    const text = ['- 这条在围栏前，算', '```', '- 这条在没闭合的围栏里，不算'].join('\n')
    assert.deepEqual(titles([text]), ['这条在围栏前，算'])
  })

  it('没有列表标记的裸行不算——否则整段散文每行都成候选', () => {
    assert.deepEqual(titles(['我们讨论了三件事\n第一件是登录\n第二件是导出']), [])
  })

  it('太短的行不算', () => {
    // 「大项」「好」这类两三个字的清单项几乎总是别的东西——表格残片、枚举值。
    assert.deepEqual(titles(['- 好\n- 是的\n- 大项\n- 这一条够长了吧']), ['这一条够长了吧'])
  })

  it('太长的行不算——那是整段说明被写成了列表项', () => {
    const long = `- ${'很长'.repeat(80)}`
    assert.deepEqual(titles([long]), [])
  })

  it('分隔线与表格边框不算', () => {
    assert.deepEqual(titles(['---\n- ---\n- |---|---|\n- 这条是真的']), ['这条是真的'])
  })
})

describe('清理与去重', () => {
  it('去掉行内的加粗、反引号、删除线', () => {
    assert.deepEqual(titles(['- **改掉** `config.ts` 里的 ~~旧~~ 默认值']),
      ['改掉 config.ts 里的 旧 默认值'])
  })

  it('去掉行尾的脚注编号', () => {
    assert.deepEqual(titles(['- 换掉那个过期依赖 [1]']), ['换掉那个过期依赖'])
  })

  it('同一条重复提及只留一次，位置取第一次', () => {
    // 真实场景：先列计划、后逐条确认，同一条会出现两三遍。
    const found = extractCandidates(['- 修好登录页', '好的，我来做：\n- 修好登录页'])
    assert.deepEqual(found, [{ title: '修好登录页', source: 0 }])
  })

  it('去重不区分大小写', () => {
    assert.deepEqual(titles(['- Fix the login page', '- fix the login page']),
      ['Fix the login page'])
  })

  it('记下每条来自第几段', () => {
    const found = extractCandidates(['- 第一段的事', '- 第二段的事'])
    assert.deepEqual(found.map(one => one.source), [0, 1])
  })
})

describe('边界', () => {
  it('没有文本时返回空', () => {
    assert.deepEqual(extractCandidates([]), [])
  })

  it('全是空字符串时返回空', () => {
    assert.deepEqual(extractCandidates(['', '  ', '\n\n']), [])
  })

  it('一段里一条都没有也不报错', () => {
    assert.deepEqual(titles(['纯聊天，没有任何清单']), [])
  })
})
