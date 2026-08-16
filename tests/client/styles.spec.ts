/**
 * 样式的行为契约。
 *
 * 真实事故：面板最初把三层表面映射到 DSH 的 `--dsw-alias-bg-base` /
 * `bg-layer-1` / `bg-layer-2`。夜间可用，日间**完全塌掉**——DSH 在日间把这四个
 * 别名全指向同一个纯白，于是三层变成一张白纸，六条泳道彼此看不出边界，而且整片
 * 白得刺眼。
 *
 * 所以这里不再断言「必须使用 DSH 变量」（那正是出事的原因），而是断言**真正的
 * 不变量**：三层表面在明暗两套色板下都必须逐级不同。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { VELA_CSS, installStyles } from '../../src/client/styles.ts'

/** 取一条规则块的内容（从选择器到第一个右花括号）。 */
function block(selector: string): string {
  const at = VELA_CSS.indexOf(selector)
  assert.ok(at >= 0, `找不到规则块 ${selector}`)
  const rest = VELA_CSS.slice(at)
  return rest.slice(0, rest.indexOf('}'))
}

/**
 * 取两个色板块。
 *
 * 按「哪个块里定义了 `--vela-canvas`」定位，而不是按完整的选择器字符串。
 * 真实事故：给会话头部的提取块补色板时往选择器里多加了两行，按字符串
 * 定位的版本立刻全红——而那次改动本身是对的。测试该盯的是「色板里有什么」，
 * 不是「哪些选择器共用它」。
 *
 * @param from - 从哪个位置开始找。
 * @returns 那个块的文本与它的起始位置。
 */
function paletteFrom(from: number): { text: string; at: number } {
  const marker = VELA_CSS.indexOf('--vela-canvas:', from)
  assert.ok(marker >= 0, '找不到色板块（没有 --vela-canvas 的定义）')
  // 向前回找该块的开花括号，再向后到闭花括号。
  const open = VELA_CSS.lastIndexOf('{', marker)
  const close = VELA_CSS.indexOf('}', marker)
  assert.ok(open >= 0 && close > open, '色板块的花括号对不上')
  return { text: VELA_CSS.slice(open, close), at: close }
}

/** 日间色板：第一个定义色板变量的块。 */
const LIGHT = paletteFrom(0).text
/** 夜间色板：它后面那一个。 */
const DARK = paletteFrom(paletteFrom(0).at).text

/** 读一个色板块里某个变量的取值。 */
function value(palette: string, name: string): string | undefined {
  return new RegExp(`--vela-${name}:\\s*([^;]+);`).exec(palette)?.[1]?.trim()
}

/** 该色板里声明的全部 `--vela-*` 变量名。 */
function names(palette: string): string[] {
  return [...palette.matchAll(/--vela-([a-z0-9-]+):/g)].map(match => match[1]!).sort()
}

/** 三层表面，由下到上。 */
const TIERS = ['canvas', 'lane', 'card'] as const

describe('三层表面必须逐级不同', () => {
  it('日间：画布、泳道、卡片是三个不同的颜色', () => {
    const seen = TIERS.map(tier => value(LIGHT, tier))
    assert.ok(seen.every(color => color !== undefined), `缺少表面变量：${seen}`)
    assert.equal(new Set(seen).size, TIERS.length,
      `三层表面里有重复颜色（${seen.join(' / ')}）——泳道会看不出边界，这正是日间曾经塌掉的原因`)
  })

  it('夜间：同样三个不同的颜色', () => {
    const seen = TIERS.map(tier => value(DARK, tier))
    assert.ok(seen.every(color => color !== undefined), `缺少表面变量：${seen}`)
    assert.equal(new Set(seen).size, TIERS.length, `三层表面里有重复颜色（${seen.join(' / ')}）`)
  })

  it('泳道标题带与泳道体不同色，每列才有一个「头」', () => {
    for (const [label, palette] of [['日间', LIGHT], ['夜间', DARK]] as const) {
      assert.notEqual(value(palette, 'lane-head'), value(palette, 'lane'), `${label}：标题带与泳道体同色`)
    }
  })

  it('日间画布比卡片暗——卡片浮在画布上，而不是反过来', () => {
    // 只看第一段十六进制分量：#eef1f6 的 ee 应当小于 #ffffff 的 ff。
    const brightness = (color: string | undefined): number =>
      Number.parseInt(color?.replace('#', '').slice(0, 2) ?? '0', 16)
    assert.ok(brightness(value(LIGHT, 'canvas')) < brightness(value(LIGHT, 'card')),
      '日间画布必须比卡片暗，否则卡片没有浮起感')
  })

  it('日间画布不是纯白——整片纯白就是「刺眼」的来源', () => {
    assert.notEqual(value(LIGHT, 'canvas')?.toLowerCase(), '#ffffff')
    assert.notEqual(value(LIGHT, 'canvas')?.toLowerCase(), '#fff')
  })

  /**
   * 夜间把阴影设成了 `none`，所以卡片能不能浮起来**完全**靠亮度差。
   *
   * 一次浏览器里的目视验证抓到了这个：早期卡片取 `#212734`、泳道取 `#171b23`，
   * 只差十几个度，实测“浮起感微弱”。阴影又是 `none`，于是没有任何其他线索。
   */
  it('夜间卡片与泳道的亮度差要够大——那里没有阴影可依靠', () => {
    const level = (color: string | undefined): number =>
      Number.parseInt(color?.replace('#', '').slice(0, 2) ?? '0', 16)
    const card = level(value(DARK, 'card'))
    const lane = level(value(DARK, 'lane'))
    assert.ok(card > lane, '夜间卡片必须比泳道亮')
    assert.ok(card - lane >= 12,
      `夜间卡片与泳道只差 ${card - lane} 个度，卡片浮不起来（夜间阴影是 none，没有备胎）`)
  })
})

/**
 * 四档优先必须互相可分。
 *
 * 一次浏览器里的目视验证抓到了这个：当时只有 `urgent`/`high` 一条规则，
 * `low` 与 `medium` 共用默认样式，于是四档在颜色上只有两种。
 */
describe('四档优先必须互相可分', () => {
  it('medium 有自己的颜色，不与默认（无/低）同色', () => {
    const rule = block("[data-vela-chip][data-tone='medium'] {")
    assert.match(rule, /var\(--vela-info/, 'medium 要用一个介于默认与高之间的色')
  })

  it('urgent 与 high 不能完全一样——一列卡片里得分得出载重', () => {
    const rule = block("[data-vela-chip][data-tone='urgent'] {")
    // 不另开色相（那会让四档看起来像四个不同的东西），只把同一色相推重。
    assert.match(rule, /border-color|font-weight/, 'urgent 要在 high 之上再加一层区分')
  })

  it('四个档位的呈现两两不同', () => {
    // 默认（无/低）走 [data-vela-chip] 本体；medium、high、urgent 各有额外规则。
    const base = block('[data-vela-chip] {')
    const medium = block("[data-vela-chip][data-tone='medium'] {")
    const high = block("[data-vela-chip][data-tone='urgent'],")
    const urgent = block("[data-vela-chip][data-tone='urgent'] {")
    const shapes = [base, medium, high, urgent]
    assert.equal(new Set(shapes).size, shapes.length, '有两个档位的规则完全相同')
  })
})

describe('明暗两套色板必须成对', () => {
  it('日间声明的每个变量夜间都有覆盖，反之亦然', () => {
    assert.deepEqual(names(DARK), names(LIGHT),
      '两套色板的变量集合不一致——缺一个就会在某个模式下漏出另一模式的颜色')
  })

  it('夜间用宿主自己的主题钩子，而不是猜系统偏好', () => {
    // prefers-color-scheme 会在用户手动切换主题（不跟随系统）时给出错误答案。
    assert.match(VELA_CSS, /body\[data-ds-dark-theme\]/)
  })

  it('规则体只引用变量，不直接写颜色', () => {
    // 色值集中在两个色板块里；其余规则一律走 var()，否则夜间会漏色。
    const rules = VELA_CSS.replace(LIGHT, '').replace(DARK, '')
    const literals = rules.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(/g) ?? []
    assert.deepEqual(literals, [], `这些颜色写在了规则体里而不是色板里：${literals.join(', ')}`)
  })
})

describe('面板必须不透明且铺满', () => {
  it('面板根节点有背景——没有它底下的会话界面会透上来', () => {
    assert.match(block('[data-vela-panel] {'), /background:\s*var\(--vela-canvas\)/)
  })

  it('面板自己收回 pointer-events——overlay 父层是点击穿透的', () => {
    assert.match(block('[data-vela-panel] {'), /pointer-events:\s*auto/)
  })

  it('面板铺满 overlay 层', () => {
    const panel = block('[data-vela-panel] {')
    assert.match(panel, /position:\s*absolute/)
    assert.match(panel, /inset:\s*0/)
  })
})

describe('可访问性与布局', () => {
  it('键盘焦点有可见轮廓', () => {
    assert.match(VELA_CSS, /:focus-visible/)
  })

  it('尊重 reduced-motion', () => {
    assert.match(VELA_CSS, /@media \(prefers-reduced-motion: reduce\)/)
  })

  it('每列内部滚动，一列很长不会把整个看板拉长', () => {
    assert.match(block('[data-vela-lane-body] {'), /overflow-y:\s*auto/)
  })

  it('长标题换行而不是溢出压到别的元素上', () => {
    assert.match(block('[data-vela-card-title] {'), /overflow-wrap/)
  })

  it('六列在 1152px 宽的窗口里能一次放下', () => {
    // 真实事故：最小列宽曾是 228px，六列总宽 1442px，第六列 Failed 被挤出
    // 屏幕。看板的全部意义是「一眼看全」，看不到的列等于不存在。
    const grid = block('[data-vela-grid] {')
    const minWidth = Number(/minmax\((\d+)px/.exec(grid)?.[1])
    const gap = Number(/gap:\s*(\d+)px/.exec(grid)?.[1])
    const padding = Number(/padding:\s*(\d+)px/.exec(grid)?.[1])
    assert.ok(Number.isFinite(minWidth), '读不到最小列宽')
    const total = minWidth * 6 + gap * 5 + padding * 2
    assert.ok(total <= 1152, `六列总宽 ${total}px 超过 1152px，第六列会被挤出屏幕`)
  })

  it('放不下时横向滚动，而不是裁掉或把列压扁', () => {
    assert.match(block('[data-vela-grid] {'), /overflow-x:\s*auto/)
  })
})

/** 一个够用的最小 document 替身：只实现 installStyles 用到的那几个方法。 */
function fakeDocument(): { doc: Document; tags: { removed: boolean; content: string }[] } {
  const tags: { removed: boolean; content: string }[] = []
  const children: unknown[] = []
  const doc = {
    querySelector: (selector: string) =>
      (selector.includes('data-plugin') && children.length > 0 ? children[0] : null),
    createElement: () => {
      const record = { removed: false, content: '' }
      tags.push(record)
      return {
        setAttribute: () => undefined,
        set textContent(value: string) { record.content = value },
        remove: () => { record.removed = true; children.length = 0 },
      }
    },
    head: { appendChild: (node: unknown) => { children.push(node) } },
  }
  return { doc: doc as unknown as Document, tags }
}

describe('installStyles', () => {
  it('注入一个带 CSS 的标签，并可撤销', () => {
    const { doc, tags } = fakeDocument()
    const dispose = installStyles(doc)
    assert.equal(tags.length, 1)
    assert.ok(tags[0]?.content.includes('data-vela-panel'))
    dispose()
    assert.equal(tags[0]?.removed, true)
  })

  it('已注入过则不再重复注入——HMR 会重挂 client fiber', () => {
    const { doc, tags } = fakeDocument()
    installStyles(doc)
    installStyles(doc)
    assert.equal(tags.length, 1, '重复调用不应堆叠 style 标签')
  })

  it('没有 document 时是无操作，不抛异常', () => {
    const dispose = installStyles(undefined)
    dispose()
  })
})
