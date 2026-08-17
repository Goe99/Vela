/**
 * OKF 头部解析的行为契约（ADR-0023）。
 *
 * 这一层的价值全在**边界**上：往返不丢字段、不认识的键原样留着、读不懂时
 * 报出哪一行。因此这里的用例大多是「坏文件」而不是「好文件」——好文件只
 * 需要证明往返，坏文件才决定 Operator 看到的是明确的错误还是静默的数据丢失。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  OkfParseError, parseDocument, parseFrontmatter, serializeDocument, serializeFrontmatter,
  readString, readNumber, readList, readRecords, readRecord,
} from '../../src/domain/okf-frontmatter.ts'

/** 造一份最小合规文档：有头部、`type` 非空。 */
function doc(head: string, body = ''): string {
  return `---\n${head}\n---\n\n${body}`
}

describe('头部往返', () => {
  it('标量、数组、对象、对象数组四种形状都能往返', () => {
    const text = doc([
      'type: Run Summary',
      'title: 给 ordering 补测试',
      'status: stable',
      'tags: [workspace:vela-1a2b3c4d, issue:12]',
      'generated:',
      '  by: vela/0.3.0',
      '  at: 2026-08-17T09:00:00.000Z',
      'verified:',
      '  - by: human:operator',
      '    at: 2026-08-17T10:00:00.000Z',
      'sources:',
      '  - author: vela/0.3.0',
      '    usage_count: 3',
      '    last_modified: 2026-08-17T10:00:00.000Z',
    ].join('\n'), '## 结论\n\n跑通了。')
    const first = parseDocument(text)
    const second = parseDocument(serializeDocument(first))
    assert.deepEqual([...second.frontmatter], [...first.frontmatter])
    assert.equal(second.body, first.body)
  })

  it('不认识的键原样保留并回写', () => {
    // OKF 要求消费者容忍未知字段。丢掉它们等于在别人的知识包上偷偷删数据。
    const text = doc('type: Run Summary\nsomeone_elses_key: 保留我\nnested_stranger:\n  a: 1')
    const parsed = parseDocument(text)
    assert.equal(readString(parsed.frontmatter, 'someone_elses_key'), '保留我')
    const round = serializeDocument(parsed)
    assert.match(round, /someone_elses_key: 保留我/)
    assert.match(round, /nested_stranger:\n {2}a: 1/)
  })

  it('已知键排在前面，未知键按原顺序在后', () => {
    const text = doc('zzz_custom: 1\ntitle: 标题\ntype: Run Summary\naaa_custom: 2')
    const head = serializeFrontmatter(parseDocument(text).frontmatter)
    const order = head.split('\n').filter(line => line.includes(':')).map(line => line.split(':')[0])
    assert.deepEqual(order, ['type', 'title', 'zzz_custom', 'aaa_custom'])
  })

  it('带引号的数字保持字符串，裸数字读成数字', () => {
    // 往返的死穴：`title: "3"` 若读成数字，写回去就变成 `title: 3`。
    const parsed = parseFrontmatter(['type: Run Summary', 'title: "3"', 'count: 3'])
    assert.equal(readString(parsed, 'title'), '3')
    assert.equal(readNumber(parsed, 'count'), 3)
    assert.match(serializeFrontmatter(parsed), /title: "3"/)
  })

  it('值里带冒号、井号、换行的字符串加引号后仍能往返', () => {
    const parsed = parseFrontmatter([
      'type: Run Summary',
      'description: "修好了：登录页 #12"',
      'note: "第一行\\n第二行"',
    ])
    assert.equal(readString(parsed, 'description'), '修好了：登录页 #12')
    assert.equal(readString(parsed, 'note'), '第一行\n第二行')
    const again = parseFrontmatter(serializeFrontmatter(parsed).split('\n').slice(1, -2))
    assert.equal(readString(again, 'note'), '第一行\n第二行')
  })

  it('空值读成空字符串，不猜 null', () => {
    const parsed = parseFrontmatter(['type: Run Summary', 'description:'])
    assert.equal(readString(parsed, 'description'), '')
    assert.match(serializeFrontmatter(parsed), /description: ""/)
  })

  it('空数组与空对象写成行内形式', () => {
    const parsed = parseFrontmatter(['type: Run Summary', 'tags: []'])
    assert.deepEqual(readList(parsed, 'tags'), [])
    assert.match(serializeFrontmatter(parsed), /tags: \[\]/)
  })

  it('行内数组里带引号的逗号不被当作分隔', () => {
    const parsed = parseFrontmatter(['type: Run Summary', 'tags: ["a,b", c]'])
    assert.deepEqual(readList(parsed, 'tags'), ['a,b', 'c'])
  })

  it('块式标量数组也认', () => {
    const parsed = parseFrontmatter(['type: Run Summary', 'tags:', '  - first', '  - second'])
    assert.deepEqual(readList(parsed, 'tags'), ['first', 'second'])
  })
})

describe('正文', () => {
  it('头部之后的内容是正文，首尾空行裁掉', () => {
    const parsed = parseDocument('---\ntype: Run Summary\n---\n\n\n## 结论\n\n好了\n\n\n')
    assert.equal(parsed.body, '## 结论\n\n好了')
  })

  it('正文里出现 --- 不会被当成头部结束的第二道栅栏', () => {
    // 分隔线在 Markdown 正文里很常见；头部一旦闭合就不该再找栅栏。
    const parsed = parseDocument('---\ntype: Run Summary\n---\n\n上\n\n---\n\n下')
    assert.equal(readString(parsed.frontmatter, 'type'), 'Run Summary')
    assert.equal(parsed.body, '上\n\n---\n\n下')
  })

  it('只有头部没有正文时序列化不留多余空行', () => {
    const parsed = parseDocument('---\ntype: Run Summary\n---\n')
    assert.equal(serializeDocument(parsed), '---\ntype: Run Summary\n---\n')
  })

  it('文件以 BOM 或空行开头也能读', () => {
    const parsed = parseDocument('\uFEFF\n---\ntype: Run Summary\n---\n')
    assert.equal(readString(parsed.frontmatter, 'type'), 'Run Summary')
  })
})

describe('读不懂就报错，且指出哪一行', () => {
  /** 跑一段一定会失败的解析，把错误拿回来断言。 */
  function failure(run: () => unknown): OkfParseError {
    try {
      run()
    } catch (error) {
      if (!(error instanceof OkfParseError)) throw error
      return error
    }
    throw new Error('本该报错却没有')
  }

  it('没有头部', () => {
    const error = failure(() => parseDocument('# 就是一篇普通 Markdown\n'))
    assert.equal(error.line, 1)
  })

  it('头部没有闭合', () => {
    const error = failure(() => parseDocument('---\ntype: Run Summary\n'))
    assert.equal(error.line, 2)
    assert.match(error.message, /没有闭合/)
  })

  it('缺冒号的行报出行号', () => {
    const error = failure(() => parseDocument('---\ntype: Run Summary\n这一行没有冒号\n---\n'))
    assert.equal(error.line, 3)
  })

  it('同一个键出现两次报错而不是后者覆盖前者', () => {
    // 覆盖是最坏的处理：文件里明明写着两个值，读出来只剩一个且没人知道。
    const error = failure(() => parseDocument('---\ntype: A\ntype: B\n---\n'))
    assert.equal(error.line, 3)
    assert.equal(error.key, 'type')
  })

  it('引号没闭合报出键名', () => {
    const error = failure(() => parseDocument('---\ntype: "Run Summary\n---\n'))
    assert.equal(error.key, 'type')
    assert.equal(error.line, 2)
  })

  it('嵌套超过一层直接拒绝，不静默丢深处的字段', () => {
    const error = failure(() => parseDocument([
      '---', 'type: Run Summary', 'deep:', '  level:', '    too: far', '---', '',
    ].join('\n')))
    assert.equal(error.line, 4)
    assert.match(error.message, /一层/)
  })

  it('数组里混了标量项与对象项', () => {
    const error = failure(() => parseDocument([
      '---', 'type: Run Summary', 'mixed:', '  - plain', '  - by: someone', '---', '',
    ].join('\n')))
    assert.match(error.message, /混/)
  })

  it('不挂在任何键下的缩进行', () => {
    const error = failure(() => parseDocument('---\n  孤儿行\ntype: A\n---\n'))
    assert.equal(error.line, 2)
  })
})

describe('取值辅助', () => {
  it('类型不符时给 undefined 而不是硬转', () => {
    const parsed = parseFrontmatter(['type: Run Summary', 'count: 7', 'tags: [a]'])
    assert.equal(readString(parsed, 'count'), undefined)
    assert.equal(readNumber(parsed, 'type'), undefined)
    assert.equal(readRecord(parsed, 'tags'), undefined)
    assert.deepEqual(readRecords(parsed, 'tags'), [])
  })

  it('对象数组与单个对象分得开', () => {
    const parsed = parseFrontmatter([
      'type: Run Summary',
      'generated:', '  by: vela/0.3.0',
      'verified:', '  - by: human:operator', '    at: 2026-08-17T10:00:00.000Z',
    ])
    assert.equal(readRecord(parsed, 'generated')?.by, 'vela/0.3.0')
    assert.equal(readRecords(parsed, 'verified').length, 1)
    assert.equal(readRecords(parsed, 'verified')[0]?.by, 'human:operator')
    assert.equal(readRecord(parsed, 'verified'), undefined)
  })

  it('缺失的键给出空集合而不是抛错', () => {
    const parsed = parseFrontmatter(['type: Run Summary'])
    assert.deepEqual(readList(parsed, 'tags'), [])
    assert.deepEqual(readRecords(parsed, 'verified'), [])
    assert.equal(readString(parsed, 'title'), undefined)
  })
})
