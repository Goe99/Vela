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
import { PanelSidebar } from '../../src/client/components/PanelSidebar.tsx'
import { SquadsPage } from '../../src/client/components/SquadsPage.tsx'
import { NAV_ITEMS } from '../../src/domain/nav.ts'
import type { Squad } from '../../src/domain/squad.ts'
import type { Board, Issue } from '../../src/domain/types.ts'
import { BOARD_VERSION } from '../../src/domain/types.ts'

/** 造一份注入面，形状与 client 入口里 inject 工厂的返回值一致。 */
function injected() {
  const panel = createPanelState()
  const client = new BoardClient(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      board: { version: BOARD_VERSION, nextNumber: 1, issues: [] },
      liveUsage: {},
      sandboxPresets: ['workspace-write'],
      squads: [],
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
    squads: [],
    canDispatch: true,
    liveUsage: {},
    selectedId: undefined,
    onSelect: () => undefined,
    openSession: face.openSession,
    client: face.client,
    onChanged: () => undefined,
    ...overrides,
  }
}

const sampleBoard: Board = {
  version: BOARD_VERSION,
  nextNumber: 4,
  issues: [
    {
      id: 'i1', number: 1, title: '待办的卡片', description: '', workspace: '/w',
      lane: 'backlog', priority: 'none', position: 1,
      createdAt: 1, updatedAt: 1, maxAttempts: 0, exec: {}, runs: [],
    },
    {
      id: 'i2', number: 2, title: '等验收的卡片', description: '', workspace: '/w',
      lane: 'review', priority: 'high', position: 1,
      createdAt: 1, updatedAt: 1, maxAttempts: 0, exec: {},
      runs: [{ id: 'r1', sessionId: 's1', startedAt: 1, status: 'settled', endedAt: 2, outcome: 'completed' }],
    },
    {
      id: 'i3', number: 3, title: '失败的卡片', description: '', workspace: '/w',
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
  it('编号真的渲到卡片上，且每张卡一个', () => {
    const html = renderToStaticMarkup(createElement(BoardGrid, gridProps({ issues: sampleBoard.issues })))
    for (const label of ['V-1', 'V-2', 'V-3']) {
      assert.ok(html.includes(`>${label}<`), `应渲出编号 ${label}`)
    }
    const occurrences = html.split('data-vela-number').length - 1
    assert.equal(occurrences, 3, '三张卡应恰好三个编号位')
  })

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
      id: 'i4', number: 4, title: '正在跑', description: '', workspace: '/w',
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
      id: 'i5', number: 5, title: '烧着', description: '', workspace: '/w',
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
      squads: [],
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

describe('PanelSidebar', () => {
  const sidebarProps = (overrides: Record<string, unknown> = {}) => ({
    current: 'board' as const,
    attention: 0,
    onSelect: () => undefined,
    onClosePanel: () => undefined,
    onOpenDocument: () => undefined,
    ...overrides,
  })

  it('十二项全部渲出来，一项不少', () => {
    const html = renderToStaticMarkup(createElement(PanelSidebar, sidebarProps()))
    for (const item of NAV_ITEMS) {
      assert.ok(html.includes(`data-vela-nav-item="${item.key}"`), `缺了 ${item.key}`)
      assert.ok(html.includes(item.label), `缺了 ${item.key} 的文案`)
    }
  })

  it('三个分组标题都在', () => {
    const html = renderToStaticMarkup(createElement(PanelSidebar, sidebarProps()))
    for (const title of ['个人', '工作区', '配置']) {
      assert.ok(html.includes(title), `缺了分组 ${title}`)
    }
  })

  it('置灏项真的不可点，且两种原因分开标注', () => {
    const html = renderToStaticMarkup(createElement(PanelSidebar, sidebarProps()))
    assert.ok(/data-vela-nav-item="skills"[^>]*disabled/.test(html)
      || /disabled[^>]*data-vela-nav-item="skills"/.test(html), 'skills 应不可点')
    assert.ok(html.includes('data-disabled-reason="no-such-page"'), 'skills 的原因是「没这个页」')
    assert.ok(html.includes('data-disabled-reason="not-yet"'), '另三项的原因是「还没做」')
  })

  it('待处理为 0 时不显徐标，大于 0 时显数字', () => {
    const none = renderToStaticMarkup(createElement(PanelSidebar, sidebarProps()))
    assert.ok(!none.includes('data-vela-nav-badge'), '为零时不应有徐标')
    const some = renderToStaticMarkup(createElement(PanelSidebar, sidebarProps({ attention: 4 })))
    assert.ok(some.includes('data-vela-nav-badge'))
    assert.ok(some.includes('>4<'))
  })

  it('当前项高亮，其余不高亮', () => {
    const html = renderToStaticMarkup(createElement(PanelSidebar, sidebarProps({ current: 'squads' })))
    assert.ok(/data-vela-nav-item="squads"[^>]*data-active="true"/.test(html), 'squads 应高亮')
    assert.equal((html.match(/data-active="true"/g) ?? []).length, 1, '只能高亮一项')
  })

  it('保留 Multica 署名（License 条件 b）', () => {
    const html = renderToStaticMarkup(createElement(PanelSidebar, sidebarProps()))
    assert.ok(html.includes('Powered by Multica'))
  })
})

describe('SquadsPage', () => {
  const squad: Squad = {
    id: 'vela-backend',
    title: 'backend',
    instruction: 'you lead.',
    members: [{ name: 'coder', instruction: 'write code', abilities: ['read', 'edit'], backend: 'spawn' }],
    maxParallelMembers: 2,
  }

  const pageProps = (overrides: Record<string, unknown> = {}) => ({
    squads: [] as readonly Squad[],
    canManage: true,
    sandboxPresets: ['workspace-write'],
    platform: 'linux',
    client: injected().client,
    onChanged: () => undefined,
    ...overrides,
  })

  it('没有小队时给出空状态而不是一片空白', () => {
    const html = renderToStaticMarkup(createElement(SquadsPage, pageProps()))
    assert.ok(html.includes('data-vela-empty'))
    assert.ok(html.includes('新建小队'))
  })

  it('列出已有的小队，带队员数与号牌数', () => {
    const html = renderToStaticMarkup(createElement(SquadsPage, pageProps({ squads: [squad] })))
    assert.ok(html.includes('data-vela-squad-row="vela-backend"'))
    assert.ok(html.includes('1 名队员'))
    assert.ok(html.includes('同时最多 2 个在跑'))
  })

  it('没有可写 preset 根时整页只说明原因，不给建队入口', () => {
    const html = renderToStaticMarkup(createElement(SquadsPage, pageProps({ canManage: false })))
    assert.ok(html.includes('squadRoot'), '要告知怎么改')
    assert.ok(!html.includes('新建小队'), '不能给一个点了就报错的按钮')
  })
})
