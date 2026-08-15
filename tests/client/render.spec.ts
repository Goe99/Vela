/**
 * 组件渲染契约。这一层专门防一类 bug：**框架传给组件的 props 形状**和
 * 组件读取的方式不一致。
 *
 * 真实事故：注入面是被框架铺平到 props 上的（`props.panel`），我最初写成
 * `props.inject.panel`，纯逻辑测试全绿但一渲染就崩。所以这里按框架的真实
 * 形状把组件渲染一遍——不求验证外观，只要求**不抛异常**。
 *
 * 用 react-dom/server 而不是 jsdom：够抓住这类错误，且不引入额外依赖。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createPanelState } from '../../src/client/panel-state.ts'
import { BoardClient } from '../../src/client/board-client.ts'
import { BoardNav } from '../../src/client/components/BoardNav.tsx'
import { BoardPanel } from '../../src/client/components/BoardPanel.tsx'
import { BoardGrid } from '../../src/client/components/BoardGrid.tsx'
import type { BoardGridProps } from '../../src/client/components/BoardGrid.tsx'
import { EditIssueForm } from '../../src/client/components/EditIssueForm.tsx'
import type { Board, Issue } from '../../src/domain/types.ts'

/** 造一份注入面，形状与 client 入口里 inject 工厂的返回值一致。 */
function injected() {
  const panel = createPanelState()
  const client = new BoardClient(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      board: { version: 1, issues: [] },
      liveUsage: {},
      sandboxPresets: ['workspace-write'],
      canDispatch: true,
    }),
  }))
  return { panel, client, openSession: (): boolean => true }
}

/** 造一套 BoardGrid 的 props，只覆盖用例关心的部分。 */
function gridProps(overrides: Partial<BoardGridProps> = {}): BoardGridProps {
  const face = injected()
  return {
    issues: [],
    showWorkspace: true,
    defaultWorkspace: '/w',
    sandboxPresets: ['workspace-write', 'danger-full-access'],
    canDispatch: true,
    liveUsage: {},
    openSession: face.openSession,
    client: face.client,
    onChanged: () => undefined,
    ...overrides,
  }
}

const sampleBoard: Board = {
  version: 1,
  issues: [
    {
      id: 'i1', title: '待办的卡片', description: '', workspace: '/w',
      lane: 'backlog', priority: 'none', position: 1,
      createdAt: 1, updatedAt: 1, maxAttempts: 0, exec: {}, runs: [],
    },
    {
      id: 'i2', title: '等验收的卡片', description: '', workspace: '/w',
      lane: 'review', priority: 'high', position: 1,
      createdAt: 1, updatedAt: 1, maxAttempts: 0, exec: {},
      runs: [{ id: 'r1', sessionId: 's1', startedAt: 1, status: 'settled', endedAt: 2, outcome: 'completed' }],
    },
    {
      id: 'i3', title: '失败的卡片', description: '', workspace: '/w',
      lane: 'failed', priority: 'none', position: 1,
      createdAt: 1, updatedAt: 1, maxAttempts: 0, exec: {},
      runs: [{ id: 'r2', sessionId: 's2', startedAt: 1, status: 'settled', endedAt: 2, outcome: 'error', failure: '依赖没装' }],
    },
  ],
}

describe('BoardNav', () => {
  it('按框架铺平的 props 形状渲染，且能渲出 Vela 字样', () => {
    const html = renderToStaticMarkup(createElement(BoardNav, { ...injected(), wide: true }))
    assert.ok(html.includes('Vela'), '宽态应显示 Vela 文字')
    assert.ok(html.includes('data-vela-nav'), '应带可定位的 data 属性')
  })

  it('折叠态也能渲染', () => {
    const html = renderToStaticMarkup(createElement(BoardNav, { ...injected(), wide: false }))
    assert.ok(html.length > 0)
    assert.ok(!html.includes('>Vela<'), '折叠态不显示完整文字')
  })

  it('未传 wide 时按宽态渲染', () => {
    const html = renderToStaticMarkup(createElement(BoardNav, injected()))
    assert.ok(html.includes('Vela'))
  })
})

describe('BoardPanel', () => {
  it('关闭时渲染空——不占据 overlay 层', () => {
    const html = renderToStaticMarkup(createElement(BoardPanel, injected()))
    assert.equal(html, '', '关闭状态不应产出任何 DOM')
  })

  it('打开时渲染面板骨架且不抛异常', () => {
    const face = injected()
    face.panel.open()
    const html = renderToStaticMarkup(createElement(BoardPanel, face))
    assert.ok(html.includes('data-vela-panel'), '应渲染面板根节点')
    assert.ok(html.includes('role="dialog"'), '应是一个 dialog')
  })

  it('打开时保留 Multica 署名（Multica License 条件 b）', () => {
    const face = injected()
    face.panel.open()
    const html = renderToStaticMarkup(createElement(BoardPanel, face))
    assert.ok(html.includes('Multica'), '界面必须保留 Multica 署名')
  })
})

describe('BoardGrid', () => {
  it('空看板也能渲染出六列', () => {
    const html = renderToStaticMarkup(createElement(BoardGrid, gridProps()))
    for (const lane of ['backlog', 'todo', 'running', 'review', 'done', 'failed']) {
      assert.ok(html.includes(`data-vela-lane="${lane}"`), `应渲染 ${lane} 列`)
    }
  })

  it('卡片落在各自的 Lane 里', () => {
    const html = renderToStaticMarkup(createElement(BoardGrid, gridProps({ issues: sampleBoard.issues })))
    assert.ok(html.includes('待办的卡片'))
    assert.ok(html.includes('等验收的卡片'))
    assert.ok(html.includes('data-lane="review"'), 'review 卡片应带对应标记')
  })

  it('失败原因直接显示在卡片上，不用去翻会话', () => {
    const html = renderToStaticMarkup(createElement(BoardGrid, gridProps({ issues: sampleBoard.issues })))
    assert.ok(html.includes('依赖没装'), '失败原因应可见')
  })

  it('只有 backlog 列带建卡入口', () => {
    const html = renderToStaticMarkup(createElement(BoardGrid, gridProps({ issues: sampleBoard.issues })))
    assert.equal((html.match(/aria-label="new issue"/g) ?? []).length, 1, '建卡入口只应出现一次')
  })

  it('不能派活的部署直接没有派活按钮，而不是一个点了就报错的入口', () => {
    const withDispatch = renderToStaticMarkup(
      createElement(BoardGrid, gridProps({ issues: sampleBoard.issues, canDispatch: true })),
    )
    const without = renderToStaticMarkup(
      createElement(BoardGrid, gridProps({ issues: sampleBoard.issues, canDispatch: false })),
    )
    assert.ok(withDispatch.includes('派活'))
    assert.ok(!without.includes('派活'))
  })

  it('进行中的卡片不可拖动——拖出去会让活 Run 成为孤儿', () => {
    const running: Issue = {
      id: 'i4', title: '正在跑', description: '', workspace: '/w',
      lane: 'running', priority: 'none', position: 1,
      createdAt: 1, updatedAt: 1, maxAttempts: 0, exec: {},
      runs: [{ id: 'r3', sessionId: 's3', startedAt: 1, status: 'running' }],
    }
    const html = renderToStaticMarkup(createElement(BoardGrid, gridProps({ issues: [running] })))
    assert.ok(html.includes('data-lane="running"'))
    assert.ok(!/data-lane="running"[^>]*draggable="true"/.test(html), '进行中的卡片不应可拖')
    assert.ok(html.includes('停止'), '应提供停止入口')
  })

  it('进行中的实时用量显示出来', () => {
    const running: Issue = {
      id: 'i5', title: '烧着', description: '', workspace: '/w',
      lane: 'running', priority: 'none', position: 1,
      createdAt: 1, updatedAt: 1, maxAttempts: 0, exec: {},
      runs: [{ id: 'r4', sessionId: 's4', startedAt: 1, status: 'running' }],
    }
    const html = renderToStaticMarkup(createElement(BoardGrid, gridProps({
      issues: [running],
      liveUsage: {
        i5: {
          inputTokens: 1200, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
        },
      },
    })))
    assert.ok(html.includes('1.5k tokens'), '应显示紧凑的实时用量')
  })

  it('已结束但用量缺失时显示未知，不显示 0', () => {
    const html = renderToStaticMarkup(createElement(BoardGrid, gridProps({ issues: sampleBoard.issues })))
    assert.ok(html.includes('token 用量未知'))
    assert.ok(!html.includes('0 tokens'))
  })

  it('只在全部视图下显示卡片的 Workspace', () => {
    const shown = renderToStaticMarkup(
      createElement(BoardGrid, gridProps({ issues: sampleBoard.issues, showWorkspace: true })),
    )
    const hidden = renderToStaticMarkup(
      createElement(BoardGrid, gridProps({ issues: sampleBoard.issues, showWorkspace: false })),
    )
    assert.ok(shown.includes('<code>/w</code>'))
    assert.ok(!hidden.includes('<code>/w</code>'))
  })
})

describe('EditIssueForm', () => {
  it('把部署提供的权限档位列成选项，并以「跟随全局默认」为默认', () => {
    const face = injected()
    const issue = sampleBoard.issues[0]
    if (issue === undefined) throw new Error('sample board lost its first issue')
    const html = renderToStaticMarkup(createElement(EditIssueForm, {
      issue,
      sandboxPresets: ['workspace-write', 'danger-full-access'],
      client: face.client,
      onDone: () => undefined,
      onCancel: () => undefined,
      onError: () => undefined,
    }))
    assert.ok(html.includes('跟随全局默认'))
    assert.ok(html.includes('danger-full-access'))
    assert.ok(html.includes('自动重试上限'))
  })
})
