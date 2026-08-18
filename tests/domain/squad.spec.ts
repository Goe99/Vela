/**
 * Squad 的行为契约。
 *
 * 最重要的一条不在这里而在 `squad-dsh.spec.ts`：那里用 **DSH 自己的解析器**
 * 读我们写出的文件。自己写、自己解析、自己断言"没问题"是循环论证——真正的
 * 问题只会在 DSH 读它的时候暴露。
 *
 * 平台一律显式传入而不依赖当前机器：`shell` 这项能力在 Windows 上展开成
 * `pwsh`、其余平台成 `bash`，让测试跟着跑测的机器变就等于没测。
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  APPENDED_SECTION_HEADER, DEFAULT_MAX_PARALLEL_MEMBERS, MEMBER_OUTRO, baselineProblem,
  composeComposition, composePolicy, leaderInstruction, memberTools, parsePolicy, slugify,
  squadIdFor, toolsForAbility, validateSquad,
} from '../../src/domain/squad.ts'
import type { Squad, SquadMember } from '../../src/domain/squad.ts'
import { SquadStore } from '../../src/domain/squad-store.ts'

/** 测试统一用 linux，好让工具名展开是确定的。 */
const LINUX = 'linux'

/**
 * 一份小得多的假基准。形状上与真基准一致（顶层序列、带注释、有一行
 * persona），但略到能一眼看出追加了什么。
 *
 * 拿**真**基准做的验证在 `squad-dsh.spec.ts` 里，用 dsh 自己的解析器。这里只管
 * 追加逻辑本身，因此不依赖本机装了 dsh。
 */
const BASELINE = [
  '# 一份假基准',
  '- id: persona',
  "  name: '@deepseek-ai/dsh-persona'",
  '  config:',
  '    text: 你是一个编码 agent。',
  '',
  '- id: tool-fs',
  "  name: '@deepseek-ai/dsh-tool-fs'",
  '',
].join('\n')

/** 默认给那份假基准的 store。 */
function storeAt(
  root: string,
  platform = LINUX,
  baseline: () => Promise<string> = () => Promise.resolve(BASELINE),
): SquadStore {
  return new SquadStore(root, platform, baseline)
}

/**
 * 从一份组合文本里取回 Vela 追加的那几行。
 *
 * 反解的是我们自己写出的格式，够用就行：「这份文本是合法 YAML」那个更强的
 * 命题由 `squad-dsh.spec.ts` 拿 dsh 真正的解析器证。
 */
function appendedRows(text: string): { id: string; name: string; config: Record<string, unknown> }[] {
  const at = text.indexOf(APPENDED_SECTION_HEADER)
  if (at < 0) return []
  return text.slice(at + APPENDED_SECTION_HEADER.length).trim().split('\n\n')
    .map(block => JSON.parse(
      block.split('\n')
        .map((line, index) => (index === 0 ? line.replace(/^- /, '') : line.replace(/^ {2}/, '')))
        .join('\n'),
    ) as { id: string; name: string; config: Record<string, unknown> })
}

function member(overrides: Partial<SquadMember> = {}): SquadMember {
  return {
    name: overrides.name ?? 'coder',
    instruction: overrides.instruction ?? '你写实现代码。',
    abilities: overrides.abilities ?? ['read', 'edit'],
    ...(overrides.extraTools === undefined ? {} : { extraTools: overrides.extraTools }),
    backend: overrides.backend ?? 'spawn',
    ...(overrides.model === undefined ? {} : { model: overrides.model }),
  }
}

function squad(overrides: Partial<Squad> = {}): Squad {
  return {
    id: overrides.id ?? 'vela-backend',
    title: overrides.title ?? 'backend',
    instruction: overrides.instruction ?? '你是队长，负责拆活并验收。',
    members: overrides.members ?? [member()],
    ...(overrides.sandbox === undefined ? {} : { sandbox: overrides.sandbox }),
    maxParallelMembers: overrides.maxParallelMembers ?? DEFAULT_MAX_PARALLEL_MEMBERS,
  }
}

describe('能力组到工具名的映射', () => {
  it('shell 按平台分叉——Windows 上是 pwsh，其余是 bash', () => {
    assert.deepEqual(toolsForAbility('shell', 'win32'), ['pwsh'])
    assert.deepEqual(toolsForAbility('shell', 'linux'), ['bash'])
    assert.deepEqual(toolsForAbility('shell', 'darwin'), ['bash'])
  })

  it('映射表被钉住——改动这里等于改动一支队实际能做什么', () => {
    assert.deepEqual(toolsForAbility('read', LINUX), ['read', 'glob', 'grep'])
    assert.deepEqual(toolsForAbility('edit', LINUX), ['write', 'edit'])
    // 只有 `web_search`，没有 `web_fetch`——尽管 dsh 确实有后者。出厂基准给
    // `tool-web` 配的是 `fetch: false`，那一行只注册搜索。白名单里多一个基准没
    // 注册的名字，这支队的每次委派都会失败。这一条与真基准的一致性由
    // `squad-dsh.spec.ts` 直接对着 dsh 装的那份文件验。
    assert.deepEqual(toolsForAbility('web', LINUX), ['web_search'])
    assert.deepEqual(
      toolsForAbility('delegate', LINUX),
      ['subagent', 'subagent_fork', 'list_agents', 'send_message', 'interrupt_agent'],
    )
  })

  it('多个能力组的工具去重合并', () => {
    const tools = memberTools(member({ abilities: ['read', 'edit', 'read'] }), LINUX)
    assert.deepEqual([...tools].sort(), ['edit', 'glob', 'grep', 'read', 'write'])
  })

  it('高级口填的工具名被追加，空白项被丢掉', () => {
    const tools = memberTools(member({ abilities: ['read'], extraTools: ['lsp', '  ', ''] }), LINUX)
    assert.ok(tools.includes('lsp'))
    assert.equal(tools.filter(name => name.trim().length === 0).length, 0)
  })
})

describe('slug 与 id', () => {
  it('中文名必须真的能建出一支小队——这是最常见的取名方式', () => {
    const id = squadIdFor('后端小队')
    assert.equal(slugify('后端小队'), '', '纯中文确实压不出 slug')
    // 关键断言：推出来的 id 必须能通过校验。先前这里会得到 `vela-`，
    // 于是所有中文名的小队都建不出来。
    assert.equal(validateSquad(squad({ id, title: '后端小队' }), LINUX), undefined)
  })

  it('同一个中文名始终映到同一个 id，否则重名判定会失效', () => {
    assert.equal(squadIdFor('后端小队'), squadIdFor('后端小队'))
    assert.notEqual(squadIdFor('后端小队'), squadIdFor('前端小队'))
  })

  it('空名字推不出 id', () => {
    assert.equal(squadIdFor('   '), '')
  })

  it('英文名压成连字符形式', () => {
    assert.equal(squadIdFor('Backend Squad'), 'vela-backend-squad')
    assert.equal(slugify('  Mixed__Case!!  '), 'mixed-case')
  })

  it('中英文混排时保留 ASCII 部分，人看得出是哪支队', () => {
    assert.equal(squadIdFor('backend 小队'), 'vela-backend')
  })
})

describe('校验', () => {
  it('合法的小队通过', () => {
    assert.equal(validateSquad(squad(), LINUX), undefined)
  })

  it('没有队员的小队也合法——先建一个光杆队长是正当用法', () => {
    assert.equal(validateSquad(squad({ members: [] }), LINUX), undefined)
  })

  it('id 必须带 vela- 前缀', () => {
    assert.match(validateSquad(squad({ id: 'backend' }), LINUX) ?? '', /vela-/)
  })

  it('slug 为空时拒绝', () => {
    assert.match(validateSquad(squad({ id: 'vela-' }), LINUX) ?? '', /至少要有一个字母或数字/)
  })

  it('队员名与 DSH 自带工具撞名时拒绝', () => {
    for (const name of ['subagent', 'subagent_fork', 'send_message', 'report']) {
      assert.match(
        validateSquad(squad({ members: [member({ name })] }), LINUX) ?? '',
        /撞名/,
        `${name} 应被拒`,
      )
    }
  })

  it('队员名不合法时拒绝', () => {
    for (const name of ['Coder', '1coder', 'co-der', '', 'coder!']) {
      assert.notEqual(
        validateSquad(squad({ members: [member({ name })] }), LINUX),
        undefined,
        `${name} 应被拒`,
      )
    }
  })

  it('队员名重复时拒绝', () => {
    const dup = squad({ members: [member({ name: 'a' }), member({ name: 'a' })] })
    assert.match(validateSquad(dup, LINUX) ?? '', /重复/)
  })

  it('一项能力都没勾的队员被拒——不能让"全取消"变成静默的权限放大', () => {
    const bare = squad({ members: [member({ abilities: [], extraTools: [] })] })
    assert.match(validateSquad(bare, LINUX) ?? '', /至少要勾一项能力/)
  })

  it('号牌数量必须是不小于 1 的整数', () => {
    for (const value of [0, -1, 1.5]) {
      assert.notEqual(
        validateSquad(squad({ maxParallelMembers: value }), LINUX),
        undefined,
        `${value} 应被拒`,
      )
    }
  })
})

describe('队长的职责说明', () => {
  it('自动追加队员名册——DSH 生成的工具说明是通用话术，队长光看名字分不出谁是谁', () => {
    const text = leaderInstruction(squad({
      members: [
        member({ name: 'coder', instruction: '写实现' }),
        member({ name: 'reviewer', instruction: '只读代码提意见', abilities: ['read'] }),
      ],
    }), LINUX)
    assert.ok(text.includes('你是队长'), '要保留 Operator 自己写的那段')
    assert.ok(text.includes('`coder`'), '名册要含队员名')
    assert.ok(text.includes('写实现'))
    assert.ok(text.includes('`reviewer`'))
    assert.ok(text.includes('只读代码提意见'))
    assert.ok(text.includes('可用：'), '要告诉队长每个队员有哪些工具')
  })

  it('没有队员时不追加名册', () => {
    const text = leaderInstruction(squad({ members: [], instruction: '就我一个' }), LINUX)
    assert.equal(text, '就我一个')
  })

  it('队员没写职责时明确标注，而不是留空让队长猜', () => {
    const text = leaderInstruction(squad({ members: [member({ instruction: '  ' })] }), LINUX)
    assert.ok(text.includes('未写职责'))
  })
})

describe('组合文件的内容', () => {
  it('基准原封不动地在前面，队员只是追加在后面', () => {
    const text = composeComposition(squad({
      members: [member({ name: 'a' }), member({ name: 'b' })],
    }), LINUX, BASELINE)
    // 这是整个小队功能的地基。上一次真跑失败就是因为组合**取代**了基准：
    // 那时队长手里一个文件工具都没有，队员白名单里的名字全部解不开。
    assert.ok(text.startsWith(BASELINE), '基准必须逐字节在开头')
    const rows = appendedRows(text)
    assert.equal(rows.length, 2, '追加的只有队员，没有其他行')
    assert.equal(rows[0]?.name, '@deepseek-ai/dsh-tool-subagent')
    assert.equal(rows[0]?.config.toolName, 'a')
    assert.equal(rows[1]?.config.toolName, 'b')
  })

  it('队长的职责一个字也不进组合文件——它走开场消息', () => {
    // 两行 `dsh-persona` 会让 `deployment:persona` 注册两次而抛错，整支队起不来。
    // 基准自带一行，所以我们一行也不能加。
    const text = composeComposition(squad({ instruction: '你是队长，不要自己动手' }), LINUX, BASELINE)
    assert.ok(!text.includes('不要自己动手'), '职责不得出现在组合文件里')
    assert.equal(
      text.split('@deepseek-ai/dsh-persona').length - 1,
      1,
      '有且只有基准那一行 persona',
    )
  })

  it('每个队员带自己的职责说明与工具白名单', () => {
    const rows = appendedRows(composeComposition(squad({
      members: [member({ name: 'a', instruction: '只改前端', abilities: ['edit'] })],
    }), LINUX, BASELINE))
    const config = rows[0]!.config
    // persona = 职责原文 + Vela 追加的结束约定（要求队员干完写一句总结，
    // 这段话会被提取出来显示在泳道下方给验收的人看）。
    assert.equal(config.persona, `只改前端\n\n${MEMBER_OUTRO}`)
    assert.deepEqual((config.toolFilter as { allow: string[] }).allow, ['write', 'edit'])
    assert.equal(config.provider, 'spawn')
    // 一次性而不是可继续：可继续会把委派的默认变成后台，而后台可继续子代理
    // 不经过 provider.start()，号牌闸门也就完全拦不住（ADR-0018）。一次真跑里队长
    // 的三次委派全走了后台，号牌一次也没参与。改这个值前先读 ADR-0018。
    assert.equal(config.backgroundMode, 'one-shot')
  })

  it('队员没写职责时不写 persona 字段，而不是写一个空字符串', () => {
    const rows = appendedRows(composeComposition(squad({
      members: [member({ instruction: '   ' })],
    }), LINUX, BASELINE))
    assert.equal('persona' in rows[0]!.config, false)
  })

  it('行的顺序稳定，同一支队生成两次内容完全一致', () => {
    const target = squad({ members: [member({ name: 'a' }), member({ name: 'b' })] })
    assert.equal(
      composeComposition(target, LINUX, BASELINE),
      composeComposition(target, LINUX, BASELINE),
    )
  })

  it('fork 后端被原样写进 provider', () => {
    const rows = appendedRows(composeComposition(squad({
      members: [member({ backend: 'fork' })],
    }), LINUX, BASELINE))
    assert.equal(rows[0]?.config.provider, 'fork')
  })

  it('队员没填模型时不写 agentOptions——行里一个字都不多写', () => {
    const rows = appendedRows(composeComposition(squad({ members: [member()] }), LINUX, BASELINE))
    assert.ok(!('agentOptions' in (rows[0]?.config ?? {})), '留空就是沿用队长，不该有 agentOptions 这个键')
  })

  it('纯模型名只设 model，provider 由 DSH 从队长继承', () => {
    const rows = appendedRows(composeComposition(squad({
      members: [member({ model: 'deepseek-reasoner' })],
    }), LINUX, BASELINE))
    assert.deepEqual(rows[0]?.config.agentOptions, { model: 'deepseek-reasoner' })
  })

  it('provider/model 拆成两个字段——队员可以走与队长不同的路由', () => {
    const rows = appendedRows(composeComposition(squad({
      members: [member({ model: 'openai/gpt-5' })],
    }), LINUX, BASELINE))
    assert.deepEqual(rows[0]?.config.agentOptions, { provider: 'openai', model: 'gpt-5' })
  })

  it('模型的半边写法（「/foo」「foo/」）在校验时被拒，而不是静默回落成沿用队长', () => {
    // 静默回落是这类配置最危险的失败方式：Operator 以为是强模型，实际跑的是默认。
    assert.match(validateSquad(squad({ members: [member({ model: '/foo' })] }), LINUX) ?? '', /不合法/)
    assert.match(validateSquad(squad({ members: [member({ model: 'foo/' })] }), LINUX) ?? '', /不合法/)
    // 而合法写法通过。
    assert.equal(validateSquad(squad({ members: [member({ model: 'deepseek-reasoner' })] }), LINUX), undefined)
  })

  it('没有队员的小队就是一份基准的副本，不带多余的追加段', () => {
    const text = composeComposition(squad({ members: [] }), LINUX, BASELINE)
    assert.equal(text, BASELINE)
    assert.ok(!text.includes(APPENDED_SECTION_HEADER))
  })

  it('基准末尾没换行时补一个，不让第一个队员行粘到基准最后一行上', () => {
    const noNewline = '- id: persona\n  name: x'
    const text = composeComposition(squad({ members: [member()] }), LINUX, noNewline)
    assert.ok(text.startsWith(`${noNewline}\n`), '必须补上那个换行')
    // 没补的话这行会变成 `  name: x- {…}`，一份语法错误的 YAML。
    assert.ok(!text.includes('name: x-'))
  })

  it('追加行的缩进能让 flow 映射跳行：首行 `- {`，后续行缩进 2 格', () => {
    const text = composeComposition(squad({ members: [member()] }), LINUX, BASELINE)
    const block = text.slice(text.indexOf(APPENDED_SECTION_HEADER)).split('\n\n')[1]!
    const lines = block.trimEnd().split('\n')
    assert.equal(lines[0], '- {')
    // 首行的 `{` 落在第 2 列，后续行必须至少齐到那里。
    assert.ok(lines.slice(1).every(line => line.startsWith('  ')), '每一行都要缩进 2 格')
    assert.equal(lines.at(-1), '  }')
  })
})

describe('基准的可用性检查', () => {
  it('一份顶层序列可用', () => {
    assert.equal(baselineProblem(BASELINE), undefined)
  })

  it('空基准被拒', () => {
    assert.ok(baselineProblem('   \n  ') !== undefined)
  })

  it('一份 mapping 被拒——往它后面追加会得到语法错误的 YAML', () => {
    assert.ok(baselineProblem('key: value\nother: thing') !== undefined)
  })

  it('只有缩进过的 `- ` 不算顶层序列', () => {
    assert.ok(baselineProblem('key:\n  - nested') !== undefined)
  })

  it('带顶部注释的序列仍然可用——真基准就是这个样子', () => {
    assert.equal(baselineProblem('# 一大段注释\n#\n- id: a\n  name: b\n'), undefined)
  })
})

describe('策略文件的往返', () => {
  it('写出再读回，Operator 的原始意图一字不差', () => {
    const original = squad({
      members: [
        member({ name: 'coder', abilities: ['read', 'edit', 'shell'], extraTools: ['lsp'], model: 'deepseek-reasoner' }),
        member({ name: 'checker', abilities: ['read'], backend: 'fork', model: 'openai/gpt-5' }),
      ],
      sandbox: 'workspace-write',
      maxParallelMembers: 2,
    })
    assert.deepEqual(parsePolicy(original.id, composePolicy(original)), original)
  })

  it('读的是策略文件而不是组合文件——能力勾选在组合里已被展开成工具名，反推会丢信息', () => {
    // shell 在 linux 上展开成 bash。若从组合文件反推，我们只会看到 bash，
    // 无法区分"勾了 shell"与"在高级口手填了 bash"。
    const original = squad({ members: [member({ abilities: ['shell'] })] })
    const back = parsePolicy(original.id, composePolicy(original))
    assert.deepEqual(back?.members[0]?.abilities, ['shell'])
    assert.equal(back?.members[0]?.extraTools, undefined)
  })

  it('坏掉的策略文件读出 undefined 而不是抛异常', () => {
    assert.equal(parsePolicy('vela-x', 'not json'), undefined)
    assert.equal(parsePolicy('vela-x', '[]'), undefined)
    assert.equal(parsePolicy('vela-x', '{"version":99}'), undefined)
  })

  it('缺省字段被补上合理默认而不是变成 undefined', () => {
    const back = parsePolicy('vela-x', JSON.stringify({ version: 1 }))
    assert.equal(back?.title, 'x')
    assert.equal(back?.instruction, '')
    assert.deepEqual(back?.members, [])
    assert.equal(back?.maxParallelMembers, DEFAULT_MAX_PARALLEL_MEMBERS)
  })

  it('未知的能力名与后端被丢掉/回落，而不是原样带进运行时', () => {
    const back = parsePolicy('vela-x', JSON.stringify({
      version: 1,
      members: [{ name: 'a', instruction: '', abilities: ['read', 'fly'], backend: 'telepathy' }],
    }))
    assert.deepEqual(back?.members[0]?.abilities, ['read'])
    assert.equal(back?.members[0]?.backend, 'spawn')
  })
})

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'vela-squads-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('SquadStore', () => {
  it('拒绝相对路径的根', () => {
    assert.throws(() => storeAt('relative/presets'))
  })

  it('根不存在时列出空数组——全新安装的常态，不是错误', async () => {
    const store = storeAt(join(root, 'missing'))
    assert.deepEqual(await store.list(), [])
  })

  it('写出三个文件：组合、显示元数据、Vela 策略', async () => {
    const store = storeAt(root)
    const result = await store.write(squad())
    assert.equal(result.ok, true)
    const files = (await readdir(join(root, 'vela-backend'))).sort()
    assert.deepEqual(files, ['agent.cordis.yml', 'preset.yml', 'vela.json'])
  })

  it('写出的组合文件以基准开头——否则队长手里一个文件工具也没有', async () => {
    const store = storeAt(root)
    await store.write(squad({ members: [member()] }))
    const text = await readFile(join(root, 'vela-backend', 'agent.cordis.yml'), 'utf8')
    assert.ok(text.startsWith(BASELINE))
  })

  it('拿不到基准时拒绝写，而不是造一支跑不了的队', async () => {
    const store = storeAt(root, LINUX, () => Promise.reject(new Error('agentPresets 没挂载')))
    const result = await store.write(squad())
    assert.equal(result.ok, false)
    assert.equal(result.ok ? '' : result.code, 'io')
    // 关键：不能留下一个目录。否则看板上会多出一支派一次失败一次的小队。
    await assert.rejects(() => readdir(join(root, 'vela-backend')))
  })

  it('基准不是顶层序列时拒绝写', async () => {
    const store = storeAt(root, LINUX, () => Promise.resolve('key: value'))
    const result = await store.write(squad())
    assert.equal(result.ok, false)
    assert.equal(result.ok ? '' : result.code, 'invalid')
  })

  it('显示元数据里放的是 Operator 起的名字，DSH 的选择器会读它', async () => {
    const store = storeAt(root)
    await store.write(squad({ title: '后端小队', id: 'vela-backend' }))
    const meta = JSON.parse(await readFile(join(root, 'vela-backend', 'preset.yml'), 'utf8')) as { name: string }
    assert.equal(meta.name, '后端小队')
  })

  it('读回一支已存在的小队', async () => {
    const store = storeAt(root)
    await store.write(squad({ title: '原名' }))
    const back = await store.read('vela-backend')
    assert.equal(back.ok, true)
    assert.equal(back.ok ? back.value.title : '', '原名')
  })

  it('改完再写回不丢信息', async () => {
    const store = storeAt(root)
    await store.write(squad())
    const first = await store.read('vela-backend')
    if (!first.ok) throw new Error(first.message)
    const edited: Squad = { ...first.value, title: '改过的名字', maxParallelMembers: 1 }
    await store.write(edited)
    const second = await store.read('vela-backend')
    assert.deepEqual(second.ok ? second.value : undefined, edited)
  })

  it('非法的小队写不进去，也不留下半个目录', async () => {
    const store = storeAt(root)
    const result = await store.write(squad({ members: [member({ name: 'subagent' })] }))
    assert.equal(result.ok, false)
    assert.equal(result.ok ? '' : result.code, 'invalid')
    await assert.rejects(() => readdir(join(root, 'vela-backend')))
  })

  it('expectNew 时重名被拒', async () => {
    const store = storeAt(root)
    await store.write(squad())
    const again = await store.write(squad(), { expectNew: true })
    assert.equal(again.ok, false)
    assert.equal(again.ok ? '' : again.code, 'conflict')
  })

  it('不带 expectNew 时同名是覆盖，不是报错', async () => {
    const store = storeAt(root)
    await store.write(squad({ title: 'one' }))
    assert.equal((await store.write(squad({ title: 'two' }))).ok, true)
  })

  it('只列出 vela- 前缀的目录——Operator 手写的 preset 不是 Vela 的资产', async () => {
    const store = storeAt(root)
    await store.write(squad({ id: 'vela-a', title: 'A' }))
    await mkdir(join(root, 'my-own-preset'), { recursive: true })
    await writeFile(join(root, 'my-own-preset', 'vela.json'), '{"version":1}', 'utf8')
    assert.deepEqual((await store.list()).map(item => item.id), ['vela-a'])
  })

  it('列表跳过读不出来的小队而不是整体失败', async () => {
    const store = storeAt(root)
    await store.write(squad({ id: 'vela-good', title: 'good' }))
    await mkdir(join(root, 'vela-broken'), { recursive: true })
    await writeFile(join(root, 'vela-broken', 'vela.json'), 'garbage', 'utf8')
    assert.deepEqual((await store.list()).map(item => item.id), ['vela-good'])
  })

  it('删得掉自己创建的小队', async () => {
    const store = storeAt(root)
    await store.write(squad())
    assert.equal((await store.remove('vela-backend')).ok, true)
    assert.deepEqual(await store.list(), [])
  })

  it('删不掉不带 vela- 前缀的目录', async () => {
    const store = storeAt(root)
    await mkdir(join(root, 'standard'), { recursive: true })
    const result = await store.remove('standard')
    assert.equal(result.ok, false)
    assert.equal(result.ok ? '' : result.code, 'invalid')
    assert.ok((await readdir(root)).includes('standard'), '目录必须还在')
  })

  it('删除不存在的小队返回 not-found', async () => {
    const store = storeAt(root)
    const result = await store.remove('vela-nope')
    assert.equal(result.ok, false)
    assert.equal(result.ok ? '' : result.code, 'not-found')
  })

  it('Windows 上「跑命令」写出的是 pwsh 而不是 bash——填错会让整支队起不来', async () => {
    const store = storeAt(root, 'win32')
    await store.write(squad({ members: [member({ abilities: ['shell'] })] }))
    const text = await readFile(join(root, 'vela-backend', 'agent.cordis.yml'), 'utf8')
    const rows = appendedRows(text)
    assert.deepEqual((rows[0]?.config.toolFilter as { allow: string[] }).allow, ['pwsh'])
  })
})
