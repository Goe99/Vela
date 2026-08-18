/**
 * 详情抽屉的渲染契约（票 04）。
 *
 * 与 `render.spec.ts` 同一套路子：用 react-dom/server 把组件渲染成静态标记，
 * 断言那些**看得见的承诺**确实在输出里——不测外观，测「这个信息有没有到人眼前」。
 *
 * 独立成一个文件而不是追加进 render.spec.ts：抽屉的固件（一张跑过两次的卡）
 * 与那边的看板固件没有共用，混在一起反而要多读两屏才能找到自己关心的用例。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { BoardClient } from '../../src/client/board-client.ts'
import { BoardGrid } from '../../src/client/components/BoardGrid.tsx'
import type { BoardGridProps } from '../../src/client/components/BoardGrid.tsx'
import { IssueDrawer } from '../../src/client/components/IssueDrawer.tsx'
import type { Issue } from '../../src/domain/types.ts'
import { BOARD_VERSION } from '../../src/domain/types.ts'

/** 一个不会真发请求的 client。抽屉的渲染路径不碰网络。 */
function stubClient(): BoardClient {
  return new BoardClient(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      board: { version: BOARD_VERSION, nextNumber: 1, issues: [] },
      liveUsage: {},
    liveMembers: {},
      sandboxPresets: ['workspace-write'],
      squads: [],
      canDispatch: true,
    }),
  }))
}

/** 一张跑过两次的卡：一次出错、一次正常结束。 */
function withRuns(): Issue {
  return {
    id: 'i9',
    number: 9,
    title: '接上支付回调',
    description: '两段：先验签，再落库。',
    workspace: '/w/api',
    lane: 'review',
    priority: 'high',
    position: 1,
    createdAt: 1,
    updatedAt: 1,
    maxAttempts: 0,
    exec: { squad: 'vela-backend', sandbox: 'workspace-write', timeoutMs: 90_000 },
    runs: [
      {
        id: 'r1',
        sessionId: 's1',
        startedAt: 1_700_000_000_000,
        endedAt: 1_700_000_030_000,
        status: 'settled',
        outcome: 'error',
        failure: '验签那步拿不到公钥',
      },
      {
        id: 'r2',
        sessionId: 's2',
        startedAt: 1_700_000_100_000,
        endedAt: 1_700_000_162_500,
        status: 'settled',
        outcome: 'completed',
        usage: {
          inputTokens: 8000, outputTokens: 1200, cacheReadTokens: 400,
          cacheWriteTokens: 0, reasoningTokens: 100,
        },
      },
    ],
  }
}

type DrawerProps = Parameters<typeof IssueDrawer>[0]

function drawerProps(issue: Issue, overrides: Partial<DrawerProps> = {}): DrawerProps {
  return {
    issue,
    liveUsage: undefined,
    client: stubClient(),
    openSession: () => true,
    onChanged: () => undefined,
    onClose: () => undefined,
    ...overrides,
  }
}

function gridProps(overrides: Partial<BoardGridProps> = {}): BoardGridProps {
  return {
    issues: [],
    showWorkspace: true,
    defaultWorkspace: '/w',
    sandboxPresets: ['workspace-write'],
    squads: [],
    canDispatch: true,
    liveUsage: {},
    liveMembers: {},
    selectedId: undefined,
    onSelect: () => undefined,
    openSession: () => true,
    client: stubClient(),
    onChanged: () => undefined,
    ...overrides,
  }
}

describe('IssueDrawer', () => {
  it('显示编号、标题、描述与执行配置', () => {
    const html = renderToStaticMarkup(createElement(IssueDrawer, drawerProps(withRuns())))
    assert.ok(html.includes('V-9'))
    assert.ok(html.includes('接上支付回调'))
    assert.ok(html.includes('先验签，再落库'))
    assert.ok(html.includes('/w/api'))
    assert.ok(html.includes('vela-backend'), '派给哪支小队要看得见')
    assert.ok(html.includes('workspace-write'))
  })

  it('列出历次执行，新的在前，带耗时与 token', () => {
    const html = renderToStaticMarkup(createElement(IssueDrawer, drawerProps(withRuns())))
    assert.ok(html.includes('历次执行（2）'))
    // 第 2 次（正常结束）应当排在第 1 次之前：最近一次才是 Operator 要看的。
    assert.ok(html.indexOf('第 2 次') < html.indexOf('第 1 次'), '最近一次要在最上面')
    assert.ok(html.includes('1m02s'), '耗时要写成人能读的形式')
    // 8000 + 400 缓存读 + 1200 输出 = 9600。推理 token 已含在输出里，不重复计。
    assert.ok(html.includes('9,600'), 'token 要带千分位')
    assert.ok(html.includes('验签那步拿不到公钥'), '失败原因要直接可见，不该逼人去翻会话')
  })

  it('每次执行都有一个跳去会话的按钮', () => {
    const html = renderToStaticMarkup(createElement(IssueDrawer, drawerProps(withRuns())))
    assert.equal(html.split('看会话').length - 1, 2, '两次执行各一个')
  })

  it('结局用 data-outcome 标出来，好让颜色区分成功与失败', () => {
    const html = renderToStaticMarkup(createElement(IssueDrawer, drawerProps(withRuns())))
    assert.ok(html.includes('data-outcome="completed"'))
    assert.ok(html.includes('data-outcome="error"'))
  })

  it('一次都没跑过时给明确的空状态，而不是空白', () => {
    const fresh: Issue = { ...withRuns(), runs: [], exec: {} }
    const html = renderToStaticMarkup(createElement(IssueDrawer, drawerProps(fresh)))
    assert.ok(html.includes('历次执行（0）'))
    assert.ok(html.includes('还没有派过活'), '空状态要说清下一步做什么')
  })

  it('没有单独执行配置时说明「全用默认」', () => {
    const fresh: Issue = { ...withRuns(), exec: {} }
    const html = renderToStaticMarkup(createElement(IssueDrawer, drawerProps(fresh)))
    assert.ok(html.includes('全部用全局默认'))
  })

  it('在途那次用实时用量，而不是显示为未知', () => {
    const live: Issue = {
      ...withRuns(),
      lane: 'running',
      runs: [{ id: 'r3', sessionId: 's3', startedAt: 1_700_000_000_000, status: 'running' }],
    }
    const html = renderToStaticMarkup(createElement(IssueDrawer, drawerProps(live, {
      liveUsage: {
        inputTokens: 500, outputTokens: 100, cacheReadTokens: 0,
        cacheWriteTokens: 0, reasoningTokens: 0,
      },
    })))
    assert.ok(html.includes('正在跑'))
    assert.ok(html.includes('600'), '在途也要能看到烧了多少')
  })

  it('刚打开时保存按钮是「已保存」——没有改动就不该诱人去点', () => {
    const html = renderToStaticMarkup(createElement(IssueDrawer, drawerProps(withRuns())))
    assert.ok(html.includes('已保存'))
    assert.ok(!html.includes('撤销改动'), '没改动就不显示撤销')
  })

  it('标题与描述是可编辑的输入框，不是只读文本', () => {
    const html = renderToStaticMarkup(createElement(IssueDrawer, drawerProps(withRuns())))
    assert.ok(/<input[^>]*aria-label="标题"/.test(html))
    assert.ok(/<textarea[^>]*aria-label="描述"/.test(html))
  })

  it('耗时接近整分时不会溢出成 1m60s', () => {
    // 119.7 秒。秒数用 round 会拿到 60，渲出一个不存在的时间。
    const long: Issue = {
      ...withRuns(),
      runs: [{
        id: 'r9',
        sessionId: 's9',
        startedAt: 1_700_000_000_000,
        endedAt: 1_700_000_119_700,
        status: 'settled',
        outcome: 'completed',
      }],
    }
    const html = renderToStaticMarkup(createElement(IssueDrawer, drawerProps(long)))
    assert.ok(html.includes('1m59s'))
    assert.ok(!html.includes('1m60s'))
  })
})

describe('卡片与抽屉的联动', () => {
  const sample: Issue = {
    id: 'i1', number: 1, title: '第一张', description: '', workspace: '/w',
    lane: 'todo', priority: 'none', position: 1,
    createdAt: 1, updatedAt: 1, maxAttempts: 0, exec: {}, runs: [],
  }
  const other: Issue = { ...sample, id: 'i2', number: 2, title: '第二张', position: 2 }

  it('卡片标题是按钮——点它开详情，且键盘天然可达', () => {
    const html = renderToStaticMarkup(createElement(BoardGrid, gridProps({ issues: [sample] })))
    assert.ok(/<button[^>]*data-vela-card-title/.test(html), '标题必须是真按钮')
  })

  it('抽屉开着的那张卡带 data-selected，好高亮出来', () => {
    const html = renderToStaticMarkup(createElement(BoardGrid, gridProps({
      issues: [sample, other],
      selectedId: sample.id,
    })))
    assert.ok(html.includes('data-selected="true"'), '选中的那张要能高亮')
    assert.ok(html.includes('data-selected="false"'), '其余的不高亮')
  })
})
