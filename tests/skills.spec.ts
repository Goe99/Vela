/**
 * 技能广场宿主侧扫盘的契约。用真实的临时目录驱动 SkillCatalog——
 * 目录结构是它的全部输入，不需要 fake。
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SkillCatalog } from '../src/skills.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vela-skills-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** 在 root 下写一个目录型技能。 */
async function writeSkill(root: string, name: string, description: string, extraHead = ''): Promise<void> {
  await mkdir(join(root, name), { recursive: true })
  await writeFile(
    join(root, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n${extraHead}---\n\n正文。\n`,
    'utf8',
  )
}

describe('SkillCatalog', () => {
  it('不存在的根静默跳过——全新安装不是错误', async () => {
    const catalog = new SkillCatalog([{ path: join(dir, 'nowhere'), source: 'dsh' }])
    assert.deepEqual(await catalog.list(), [])
  })

  it('目录型技能与散装 .md 技能都被发现', async () => {
    const root = join(dir, 'dsh-skills')
    await writeSkill(root, 'asu', '简历酥化')
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'flat.md'), '---\nname: flat\ndescription: 散装技能\n---\n', 'utf8')

    const catalog = new SkillCatalog([{ path: root, source: 'dsh' }])
    const skills = await catalog.list()
    assert.deepEqual(skills.map(skill => skill.name), ['asu', 'flat'])
    assert.equal(skills[0]?.description, '简历酥化')
    assert.equal(skills[1]?.sourcePath, join(root, 'flat.md'))
  })

  it('DSH 根下的 .system 目录跳过（与 DSH 的 skipSystem 对齐）；其他根不跳', async () => {
    const dshRoot = join(dir, 'dsh')
    const agentsRoot = join(dir, 'agents')
    await writeSkill(dshRoot, '.system', '系统目录')
    await writeSkill(agentsRoot, '.system', '共享目录里就叫这个名')

    const catalog = new SkillCatalog([
      { path: dshRoot, source: 'dsh' },
      { path: agentsRoot, source: 'agents' },
    ])
    const skills = await catalog.list()
    assert.equal(skills.length, 1)
    assert.equal(skills[0]?.source, 'agents')
  })

  it('同名技能：DSH 目录盖住共享目录，被盖住的留在清单里并标记', async () => {
    const dshRoot = join(dir, 'dsh')
    const agentsRoot = join(dir, 'agents')
    await writeSkill(dshRoot, 'asu', 'dsh 里的那份')
    await writeSkill(agentsRoot, 'asu', 'agents 里的那份')

    const catalog = new SkillCatalog([
      { path: dshRoot, source: 'dsh' },
      { path: agentsRoot, source: 'agents' },
    ])
    const skills = await catalog.list()
    assert.equal(skills.length, 2)
    const winner = skills.find(skill => skill.source === 'dsh')
    const shadowed = skills.find(skill => skill.source === 'agents')
    assert.equal(winner?.effective, true)
    assert.equal(winner?.description, 'dsh 里的那份')
    assert.equal(shadowed?.effective, false)
  })

  it('读不懂的技能照样列出并标明原因，而不是消失', async () => {
    const root = join(dir, 'dsh-skills')
    await mkdir(join(root, 'broken'), { recursive: true })
    await writeFile(join(root, 'broken', 'SKILL.md'), '# 压根没有 frontmatter\n', 'utf8')

    const catalog = new SkillCatalog([{ path: root, source: 'dsh' }])
    const skills = await catalog.list()
    assert.equal(skills.length, 1)
    assert.equal(skills[0]?.name, 'broken', '用目录名兜底，让它可见')
    assert.ok(skills[0]?.problem !== undefined, '要标明读不懂')
  })

  it('非 .md 文件忽略', async () => {
    const root = join(dir, 'dsh-skills')
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'README.txt'), 'not a skill\n', 'utf8')
    await writeFile(join(root, 'notes.md.txt'), 'not a skill either\n', 'utf8')

    const catalog = new SkillCatalog([{ path: root, source: 'dsh' }])
    assert.deepEqual(await catalog.list(), [])
  })
})
