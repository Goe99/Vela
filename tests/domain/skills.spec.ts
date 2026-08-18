/**
 * 技能广场领域层的契约：技能头的容错解析，与多来源清单的优先级合并。
 *
 * 这里的解析器是**容错**的——技能文件是别人写的任意 YAML，广场的职责是
 * 「让人看到磁盘上有什么」，读不懂要标出来而不是消失。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mergeSkills, parseSkillHead } from '../../src/domain/skills.ts'
import type { InstalledSkill } from '../../src/domain/skills.ts'

describe('parseSkillHead', () => {
  it('读出名字、描述与 when-to-use', () => {
    const head = parseSkillHead([
      '---',
      'name: asu-resume',
      'description: 把真实经历包装成简历',
      'when-to-use: 用户要求做简历时',
      '---',
      '',
      '正文。',
    ].join('\n'))
    assert.equal(head?.name, 'asu-resume')
    assert.equal(head?.description, '把真实经历包装成简历')
    assert.equal(head?.whenToUse, '用户要求做简历时')
    assert.equal(head?.userOnly, false)
  })

  it('disable-model-invocation: true 标成仅手动调用', () => {
    const head = parseSkillHead('---\nname: a\ndescription: b\ndisable-model-invocation: true\n---\n')
    assert.equal(head?.userOnly, true)
  })

  it('值两端的成对引号被去掉', () => {
    const head = parseSkillHead('---\nname: "quoted-skill"\ndescription: \'带引号的描述\'\n---\n')
    assert.equal(head?.name, 'quoted-skill')
    assert.equal(head?.description, '带引号的描述')
  })

  it('块标量描述拼成一行', () => {
    const head = parseSkillHead([
      '---',
      'name: block',
      'description: >-',
      '  第一行',
      '  第二行',
      '---',
    ].join('\n'))
    assert.equal(head?.description, '第一行 第二行')
  })

  it('没有 frontmatter 返回 undefined（不是抛错）', () => {
    assert.equal(parseSkillHead('# 直接是正文\n'), undefined)
    assert.equal(parseSkillHead(''), undefined)
    // 有开头没有结尾的同样算没有。
    assert.equal(parseSkillHead('---\nname: never-closed\n'), undefined)
  })

  it('缺字段就是缺字段，不猜默认值', () => {
    const head = parseSkillHead('---\nname: only-name\n---\n')
    assert.equal(head?.name, 'only-name')
    assert.equal(head?.description, undefined)
  })

  it('嵌套的键不读——只认一层 key: value', () => {
    const head = parseSkillHead('---\nname: a\nmetadata:\n  description: 嵌套的不算\n---\n')
    assert.equal(head?.description, undefined)
  })
})

/** 造一个技能条目，只覆盖用例关心的字段。 */
function skill(name: string, source: InstalledSkill['source'], extra: Partial<InstalledSkill> = {}): InstalledSkill {
  return {
    name,
    description: '',
    userOnly: false,
    source,
    sourcePath: `/${source}/${name}`,
    effective: true,
    ...extra,
  }
}

describe('mergeSkills', () => {
  it('按组给出的顺序定优先级：先来者生效，后来者标盖住', () => {
    const merged = mergeSkills([
      [skill('asu', 'dsh')],
      [skill('asu', 'agents'), skill('offer', 'agents')],
    ])
    const asu = merged.filter(item => item.name === 'asu')
    assert.equal(asu.length, 2, '两份都要留在清单里')
    assert.equal(asu.find(item => item.source === 'dsh')?.effective, true)
    assert.equal(asu.find(item => item.source === 'agents')?.effective, false)
    assert.equal(merged.find(item => item.name === 'offer')?.effective, true)
  })

  it('输出按名字排序，与来源和顺序无关', () => {
    const merged = mergeSkills([
      [skill('zeta', 'agents'), skill('alpha', 'agents')],
      [skill('mid', 'dsh')],
    ])
    assert.deepEqual(merged.map(item => item.name), ['alpha', 'mid', 'zeta'])
  })

  it('空清单合出来还是空清单', () => {
    assert.deepEqual(mergeSkills([[], []]), [])
  })
})
