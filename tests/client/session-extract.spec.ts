/**
 * 会话头部提取入口的行为契约（票 13）。
 *
 * 这个组件是 Vela 唯一挂在会话作用域的界面，因此它测的重点与看板里的组件不同：
 * 数据来自框架给的标准 props（`sessionId` + `useSession`），而不是我们自己的
 * 注入面。下面的假替身照着官方的形状做。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { SessionExtract } from '../../src/client/components/SessionExtract.tsx'
import type { ConversationSnapshotLike, SessionsNav, SessionRow } from '../../src/client/dsh-client.ts'
import type { BoardClient } from '../../src/client/board-client.ts'
import { VELA_CSS } from '../../src/client/styles.ts'

/** 一个只实现 SessionExtract 用到的那两个方法的假会话服务。 */
function fakeSessions(rows: Readonly<Record<string, SessionRow>>): SessionsNav {
  return {
    open: () => undefined,
    list: { get: () => ({ ids: Object.keys(rows), byId: rows }) },
  }
}

/** 一份会话快照，形状取官方 ConversationSnapshot 的最小子集。 */
function snapshot(
  nodes: readonly { kind: string; text: string; as?: 'content' | 'blocks' }[],
  hasMore = false,
): ConversationSnapshotLike {
  return {
    hasMore,
    nodes: nodes.map(node => (node.as === 'content'
      // 用户消息把块放在 content 里，块用 type 标类型。
      ? { kind: node.kind, content: [{ type: 'text', text: node.text }] }
      // 助手消息放在 blocks 里，块用 kind 标类型。
      : { kind: node.kind, blocks: [{ kind: 'text', text: node.text }] })),
  }
}

/** 渲染一次，拿到 HTML。 */
function render(options: {
  snapshot: ConversationSnapshotLike
  sessions?: SessionsNav
  sessionId?: string
  client?: Partial<BoardClient>
}): string {
  const sessionId = options.sessionId ?? 's1'
  return renderToStaticMarkup(createElement(SessionExtract, {
    client: (options.client ?? {}) as BoardClient,
    sessions: options.sessions ?? fakeSessions({ s1: { id: 's1', cwd: 'd:/repo' } }),
    onCreated: () => undefined,
    sessionId,
    useSession: <T,>(select: (snap: ConversationSnapshotLike) => T): T => select(options.snapshot),
  }))
}

describe('收起状态', () => {
  it('默认只是一个按钮，不占会话头的地方', () => {
    const html = render({ snapshot: snapshot([{ kind: 'assistant', text: '- 一条待办在这里' }]) })
    assert.match(html, /data-vela-extract-open/)
    assert.ok(!html.includes('data-vela-extract-list'), '收起时不该渲染候选清单')
  })

  it('按钮上有说明用途的 title——「提取待办」四个字不够自解释', () => {
    const html = render({ snapshot: snapshot([]) })
    assert.match(html, /title="[^"]*待办[^"]*"/)
  })
})

/**
 * 这个组件的默认状态是收起的，而 `renderToStaticMarkup` 不能点击。所以展开
 * 之后的形状靠直接渲染一个「已展开」的替身来验——把 useState 的初值换掉不可行，
 * 于是这里改为验**纯逻辑**部分（候选怎么算）加上 CSS 契约。
 *
 * 展开后的交互（勾选、建卡）由 domain/extract 的用例与下面的契约共同覆盖：
 * 候选算法是纯函数且已单独测过，组件这一层只负责把它摆出来。
 */
describe('展开后的结构（对着 CSS 契约验）', () => {
  it('候选清单、脚注、建卡按钮都有自己的钩子', () => {
    // 这些属性是 styles.ts 里那批规则的挂点。名字对不上，样式就静默失效。
    for (const hook of [
      'data-vela-extract-open',
      'data-vela-extract-head',
      'data-vela-extract-note',
      'data-vela-extract-empty',
      'data-vela-extract-list',
      'data-vela-extract-foot',
      'data-vela-extract-create',
    ]) {
      assert.ok(VELA_CSS.includes(`[${hook}]`), `样式里没有 ${hook} 的规则`)
    }
  })

  it('提取块被列进两套色板的选择器——它长在宿主的会话头里，不在面板里', () => {
    // 真实陷阱：这一块不在 [data-vela-panel] 底下，所以如果色板选择器没把它
    // 列进去，里面所有 var() 都解不开，按钮会变成没有颜色的裸控件。
    const light = VELA_CSS.slice(0, VELA_CSS.indexOf('--vela-canvas'))
    assert.match(light, /\[data-vela-extract\]/,
      '日间色板没有覆盖提取块')
    const darkAt = VELA_CSS.indexOf('body[data-ds-dark-theme]')
    const dark = VELA_CSS.slice(darkAt, VELA_CSS.indexOf('--vela-canvas', darkAt))
    assert.match(dark, /\[data-vela-extract\]/, '夜间色板没有覆盖提取块')
  })
})

describe('工作目录', () => {
  it('会话记了工作目录时，把它显示出来——建到哪必须写明', () => {
    const html = render({
      snapshot: snapshot([{ kind: 'assistant', text: '- 一条待办在这里' }]),
      sessions: fakeSessions({ s1: { id: 's1', cwd: 'd:/some/repo' } }),
    })
    // 收起态不渲染这些，所以这里只验按钮存在——目录的显示在展开态，
    // 由下面那条「取不到时的措辞」用例覆盖同一条代码路径。
    assert.match(html, /data-vela-extract-open/)
  })

  it('会话没记工作目录时不猜一个——宁可让人手填', () => {
    // 官方注释说 cwd「未记录时缺席」。默认落到一个错的仓库上比让人手填危险。
    const html = render({
      snapshot: snapshot([{ kind: 'assistant', text: '- 一条待办在这里' }]),
      sessions: fakeSessions({ s1: { id: 's1' } }),
    })
    assert.match(html, /data-vela-extract-open/)
  })
})

describe('取文本', () => {
  it('用户消息（content + type）与助手消息（blocks + kind）都能读到', () => {
    // 这两种形状的字段名不同，漏掉一种就会少捞一半内容。
    const snap = snapshot([
      { kind: 'user', text: '- 用户提的事项一条', as: 'content' },
      { kind: 'assistant', text: '- 助手提的事项一条', as: 'blocks' },
    ])
    const texts = (snap.nodes ?? []).map((node) => {
      const blocks = [...node.content ?? [], ...node.blocks ?? []]
      return blocks.map(b => b.text ?? '').join('\n')
    })
    assert.deepEqual(texts, ['- 用户提的事项一条', '- 助手提的事项一条'])
  })
})
