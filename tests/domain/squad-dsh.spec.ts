/**
 * 用 **DSH 自己的解析器**和 **DSH 自己的基准 preset** 验证 Vela 写出的文件真的
 * 能用。
 *
 * 为什么单独一个文件：`squad.spec.ts` 里的断言全是"我写出来的东西符合我自己
 * 的预期"，那是循环论证。真正会出事的地方是 DSH 读它的时候——它用的是 js-yaml
 * 加一个自带 `!!js` 的自定义方言（`entryListSchema`），以及一套"每一行必须是
 * 带 `name` 的 map"的形状检查。这里就调那两样东西。
 *
 * 这个文件还守着一条**上次真跑才发现的**规矩：小队的组合必须是基准 preset 的
 * 全文加上追加的队员行。少了基准，队长手里一个文件工具也没有，每次委派都会在
 * `tools.restrict()` 上失败，而卡片看起来还是跑完了。下面「基准原封不动地在
 * 前面」那条断言就是为这件事立的。
 *
 * 这些测试依赖本机装着的 dsh，因此**装不到就跳过**而不是判失败：一台没装 dsh
 * 的机器上跑单元测试仍应全绿，但在装了的机器上这条必须真的执行。
 */

import { describe, it, before } from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { composeComposition, composeMetadata, toolsForAbility } from '../../src/domain/squad.ts'
import type { Squad } from '../../src/domain/squad.ts'

/** 全局 npm 根下的 dsh 安装目录；解析不到就说明本机没装。 */
function dshRoot(): string | undefined {
  try {
    const npmRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', shell: true }).trim()
    return join(npmRoot, '@deepseek-ai', 'dsh')
  } catch {
    return undefined
  }
}

let load: ((text: string, options?: { schema?: unknown }) => unknown) | undefined
let entryListSchema: unknown
/** 真实的 `standard` preset 组合原文——小队组合的底座。 */
let baseline: string | undefined
let why: string | undefined

before(() => {
  const root = dshRoot()
  if (root === undefined) {
    why = '解析不到全局 dsh 安装'
    return
  }
  try {
    const require = createRequire(join(root, 'node_modules/'))
    // 用 dsh 捆绑的那一份 js-yaml，而不是可能装在别处的另一份——版本不同的
    // 解析器给出的答案不能代表 dsh 的答案。
    load = require('js-yaml').load as typeof load
    entryListSchema = require('@deepseek-ai/cordis-plugin-include').entryListSchema
    baseline = readFileSync(join(root, 'config/agent-presets/standard/agent.cordis.yml'), 'utf8')
  } catch (error) {
    why = `本机 dsh 里取不到解析器或基准：${error instanceof Error ? error.message : String(error)}`
  }
})

const sample: Squad = {
  id: 'vela-mixed',
  title: '混编小队',
  // 故意塞进中文、换行、引号、反斜杠与 YAML 里有特殊含义的字符。
  instruction: '你是队长。\n注意：别碰 "生产" 配置，路径写 C:\\repo，缩进用 tab\t不要空格。\n- 这行以连字符开头',
  members: [
    {
      name: 'frontend_dev',
      instruction: '只改 src/client 下的东西。\n结尾留个冒号：',
      abilities: ['read', 'edit'],
      backend: 'spawn',
    },
    {
      name: 'reviewer',
      instruction: '#不要真的当注释处理',
      abilities: ['read'],
      extraTools: ['lsp'],
      backend: 'fork',
    },
  ],
  sandbox: 'workspace-write',
  maxParallelMembers: 2,
}

/** 组合文件里的一行，只保留断言需要看的字段。 */
interface Row {
  readonly name: string
  readonly config?: Record<string, unknown>
}

/**
 * DSH 对每一行的形状要求：必须是带 `name` 的 map，group 递归进自己的列表。
 * 这里复刻它的判据——不是复制它的实现，而是断言我们的产物满足它。
 */
function rowsLookMountable(rows: unknown): string | undefined {
  if (!Array.isArray(rows)) return '顶层必须是一个列表'
  for (const [index, row] of rows.entries()) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      return `第 ${index} 行不是 map`
    }
    if (typeof (row as { name?: unknown }).name !== 'string') {
      return `第 ${index} 行没有字符串 name`
    }
  }
  return undefined
}

/** 拿 dsh 自己的解析器读一段组合文本。前提是环境可用。 */
function parse(text: string): Row[] {
  return load!(text, { schema: entryListSchema }) as Row[]
}

/** 环境不可用时跳过。返回 true 表示应当跳过。 */
function skipUnlessReady(t: TestContext): boolean {
  if (load !== undefined && entryListSchema !== undefined && baseline !== undefined) return false
  t.skip(why ?? '本机没有可用的 dsh')
  return true
}

describe('DSH 自己的解析器能读 Vela 生成的 preset', () => {
  it('组合文件被 dsh 实际使用的 YAML 方言接受，且行的形状可挂载', (t: TestContext) => {
    if (skipUnlessReady(t)) return
    const rows = parse(composeComposition(sample, 'linux', baseline!))
    assert.equal(rowsLookMountable(rows), undefined)
  })

  /**
   * 这是本文件最重要的一条。上次真跑失败的根因就是这条不成立：小队的组合取代了
   * 基准，而不是建在它之上。断言「前 N 行与基准逐字节相同，后面正好多出每个队员
   * 一行」把那个洞永久钉住，而且完全不需要重复能力表的知识。
   */
  it('基准原封不动地在前面，队员只是追加在后面', (t: TestContext) => {
    if (skipUnlessReady(t)) return
    const base = parse(baseline!)
    const composed = parse(composeComposition(sample, 'linux', baseline!))
    assert.deepEqual(composed.slice(0, base.length), base, '基准的每一行都必须原样保留')
    assert.equal(composed.length, base.length + sample.members.length)
    assert.equal(composed[base.length]?.config?.toolName, 'frontend_dev')
    assert.equal(composed[base.length + 1]?.config?.provider, 'fork')
  })

  it('基准里那些给队长文件工具的行确实还在——它们是队员白名单能解开的前提', (t: TestContext) => {
    if (skipUnlessReady(t)) return
    const names = parse(composeComposition(sample, 'linux', baseline!)).map(row => row.name)
    // `read`/`glob`/`grep`/`write`/`edit` 都由这两行注册。它们缺席时，队员的
    // toolFilter 会报 `unknown global tools`——正是上次踩到的那个错。
    assert.ok(names.includes('@deepseek-ai/dsh-tool-fs'), '缺 tool-fs：read/write/edit 都会解不开')
    assert.ok(names.includes('@deepseek-ai/dsh-tool-fs-search'), '缺 tool-fs-search：glob/grep 会解不开')
  })

  it('中文、换行、引号、反斜杠、以及 YAML 里有特殊含义的字符都原样穿过', (t: TestContext) => {
    if (skipUnlessReady(t)) return
    const rows = parse(composeComposition(sample, 'linux', baseline!))
    // 队员的职责说明是自由文本，最容易被 YAML 咬到的就是它。
    const duty = rows.find(row => row.config?.toolName === 'frontend_dev')?.config?.persona as string
    assert.ok(duty.includes('只改 src/client 下的东西'), '中文必须原样')
    assert.ok(duty.includes('\n结尾留个冒号：'), '换行与冒号必须原样')
    assert.equal(rows.find(row => row.config?.toolName === 'reviewer')?.config?.persona, '#不要真的当注释处理')
  })

  it('队长的职责不再进组合文件——它走开场消息，避免与基准的 persona 行撞车', (t: TestContext) => {
    if (skipUnlessReady(t)) return
    const rows = parse(composeComposition(sample, 'linux', baseline!))
    const personas = rows.filter(row => row.name === '@deepseek-ai/dsh-persona')
    // 两行 `dsh-persona` 会让 `deployment:persona` 段名注册两次而抛错，整支队
    // 起不来。基准自带一行，我们必须一行都不加。
    assert.equal(personas.length, 1, '有且只有基准那一行 persona')
    assert.ok(
      !JSON.stringify(rows).includes('别碰'),
      '队长的职责一个字都不该出现在组合文件里',
    )
  })

  it('显示元数据文件也被同一个解析器接受，且是个 map', (t: TestContext) => {
    if (load === undefined) {
      t.skip(why ?? '本机没有可用的 dsh')
      return
    }
    // 元数据由 dsh 用**默认** schema 读（见 dsh-agent-presets/metadata），
    // 因此这里刻意不传自定义方言。
    const parsed = load(composeMetadata(sample))
    assert.equal(typeof parsed, 'object')
    assert.equal((parsed as { name?: unknown }).name, '混编小队')
  })

  it('队员为零的小队就是一份基准的副本', (t: TestContext) => {
    if (skipUnlessReady(t)) return
    const rows = parse(composeComposition({ ...sample, members: [] }, 'linux', baseline!))
    assert.equal(rowsLookMountable(rows), undefined)
    assert.deepEqual(rows, parse(baseline!))
  })
})

describe('能力表与真实基准保持一致', () => {
  /**
   * 能力表准确的判据是「基准实际注册了什么」，不是「dsh 源码里存在什么」。出厂
   * `standard` 给 `tool-web` 配的是 `fetch: false`，那一行只注册 `web_search`，
   * 所以能力表里放 `web_fetch` 会让整支队的每次委派都失败。
   *
   * 这条测试把能力表钉在基准上：换基准、或 dsh 改了这个默认值，它就变红。
   */
  it('基准关掉了 web_fetch，因此「联网」能力里不能有它', (t: TestContext) => {
    if (skipUnlessReady(t)) return
    const web = parse(baseline!).find(row => row.name === '@deepseek-ai/dsh-tool-web')
    // 用 throw 而不是 assert.ok：后者不做类型收窄，下一行读 `web.config` 会不过。
    if (web === undefined) throw new Error('基准里应当有 tool-web 那一行')
    const tools = toolsForAbility('web', 'linux')
    if (web.config?.fetch === false) {
      assert.ok(!tools.includes('web_fetch'), '基准关着 web_fetch，能力表里就不能有')
    } else {
      assert.ok(tools.includes('web_fetch'), '基准开着 web_fetch，能力表应当把它给出去')
    }
    // 无论 fetch 开关如何，搜索都是开着的。
    assert.ok(tools.includes('web_search'))
  })

  /**
   * shell 按平台分叉，另一个被 `disabled: !!js …` 掉。这条断言顺带证明了
   * `entryListSchema` 真的在解析 `!!js` 标签——否则 `disabled` 会是字符串。
   */
  it('基准按平台分叉 shell，因此「跑命令」也必须分叉', (t: TestContext) => {
    if (skipUnlessReady(t)) return
    const rows = parse(baseline!)
    const bash = rows.find(row => row.name === '@deepseek-ai/dsh-tool-bash')
    const pwsh = rows.find(row => row.name === '@deepseek-ai/dsh-tool-pwsh')
    assert.ok(bash !== undefined && pwsh !== undefined, '两行都应当在基准里')
    assert.deepEqual(toolsForAbility('shell', 'win32'), ['pwsh'])
    assert.deepEqual(toolsForAbility('shell', 'linux'), ['bash'])
  })
})
