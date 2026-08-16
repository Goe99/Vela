/**
 * 全幅 Board 面板（票 03，挂 shell.overlay）。overlay 层是 absolute inset:0 /
 * z-index:20 / pointer-events:none 的点击穿透层，因此这里的根节点必须自己开启
 * pointer-events（样式里做），并靠 data-* 提供样式钩子（不耦合哈希 class）。
 *
 * 面板关闭时渲染 null——不占据 overlay、不拦截下面的点击。打开时：
 * - 全幅覆盖（含 sidebar 之上），因为 shell.overlay 的 owner props 是空对象，
 *   拿不到 sidebar 宽度，全幅是唯一稳妥的几何（ADR-0002）。
 * - Escape 关闭；打开时把焦点移入面板，关闭时不劫持。
 * - 打开期间轮询 Board 视图；失败保留上次成功快照。
 */

import { createElement, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { VelaInjected } from '../index.ts'
import type { BoardView } from '../board-client.ts'
import type { NavView } from '../../domain/nav.ts'
import { searchIssues } from '../../domain/search.ts'
import { BoardGrid } from './BoardGrid.tsx'
import { IssueDrawer } from './IssueDrawer.tsx'
import { PanelSidebar } from './PanelSidebar.tsx'
import { SquadsPage } from './SquadsPage.tsx'

/**
 * 面板 entry 的 props。shell.overlay 不给 owner props，所以全部来自注入面
 * ——而注入面是**直接铺平到 props 上**的，不套在 props.inject。
 */
export type BoardPanelProps = VelaInjected

/** 打开时的轮询间隔。够实时，又不打爆回环。 */
const POLL_MS = 2000

/** 「全部 Workspace」这个筛选选项的哨兵值。 */
const ALL = '\u0000all'

/** 全幅 Board 面板。 */
export function BoardPanel(props: BoardPanelProps): ReturnType<typeof createElement> | null {
  const { panel, client } = props
  const [isOpen, setOpen] = useState(panel.isOpen())
  const [view, setView] = useState<BoardView | undefined>(client.snapshot)
  const [workspace, setWorkspace] = useState<string>(ALL)
  const [nav, setNav] = useState<NavView>('board')
  /**
   * 搜索词。**不落盘**（票 11）：刷新后回到未搜索状态。一个被持久化的搜索词
   * 会让下一次打开看板时看到一个残缺的看板，而原因藏在输入框里。
   */
  const [query, setQuery] = useState('')
  const [notice, setNotice] = useState<string | undefined>(undefined)
  /**
   * 详情抽屉里那张卡的 id。存 id 而不是整个 Issue 对象：轮询会拿回新快照，
   * 存对象会让抽屉停在打开那一瞬的旧数据上（比如 Run 跑完了但抽屉里还写着
   * 「正在跑」）。
   */
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined)
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const unsubscribe = panel.subscribe(() => setOpen(panel.isOpen()))
    return () => { unsubscribe() }
  }, [panel])

  const refresh = useCallback(async () => {
    const next = await client.refresh()
    if (next !== undefined) setView(next)
  }, [client])

  // 打开时轮询，关闭时停。in-flight guard 在 client 内，这里只管调度。
  useEffect(() => {
    if (!isOpen) return undefined
    void refresh()
    const timer = setInterval(() => { void refresh() }, POLL_MS)
    return () => { clearInterval(timer) }
  }, [isOpen, refresh])

  // Escape 关闭。只在打开时挂 listener，关闭即摸。
  //
  // **分层处理在这一处完成**：抽屉开着时这一下只关抽屉。抽屉自己再挂一个
  // window listener 会变成一个顺序问题（两个都会跑，于是一下 Escape 关掉两层）。
  useEffect(() => {
    if (!isOpen) return undefined
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (selectedId !== undefined) {
        setSelectedId(undefined)
        return
      }
      panel.close()
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [isOpen, panel, selectedId])

  // 打开时把焦点移入面板，避免焦点仍留在下面的隐藏 UI 上。
  useEffect(() => {
    if (isOpen) rootRef.current?.focus()
  }, [isOpen])

  const workspaces = useMemo(() => {
    const seen = new Set<string>()
    for (const issue of view?.board.issues ?? []) seen.add(issue.workspace)
    return [...seen].sort()
  }, [view])

  // 筛选的目标 Workspace 消失后（最后一张卡片被删）回到全部，免得看到空看板。
  useEffect(() => {
    if (workspace !== ALL && !workspaces.includes(workspace)) setWorkspace(ALL)
  }, [workspace, workspaces])

  if (!isOpen) return null

  const all = view?.board.issues ?? []
  const inWorkspace = workspace === ALL ? all : all.filter(issue => issue.workspace === workspace)
  // 「待你处理」= 待验收 + 失败。这两条 Lane 是唯一需要 Operator 动手的（ADR-0020）。
  const attentionIssues = inWorkspace.filter(issue => issue.lane === 'review' || issue.lane === 'failed')
  // 徽标数字不受 Workspace 筛选影响：它是“全局还有多少事等你”，筛掉一部分
  // 会让你以为活干完了。
  const attentionCount = all.filter(issue => issue.lane === 'review' || issue.lane === 'failed').length
  const inNav = nav === 'attention' ? attentionIssues : inWorkspace
  // 搜索叠在 Workspace 筛选之后：两者都是收窄，叠加才是人的预期（票 11）。
  const visible = searchIssues(inNav, query)
  const searching = query.trim().length > 0
  // 从最新快照里重新取那张卡。卡被删掉时这里自然变成 undefined，抽屉随之消失
  // ——不需要在删除路径上额外做一步清理。
  const selected = selectedId === undefined
    ? undefined
    : all.find(issue => issue.id === selectedId)

  const openDocument = (target: Parameters<typeof client.openDocument>[0]): void => {
    void client.openDocument(target).then((outcome) => {
      // opened=false 不是错误：宿主打不开时把路径告知，比一句报错有用。
      if (outcome.opened) {
        setNotice(undefined)
        return
      }
      setNotice(outcome.path === undefined
        ? '这个环境打不开配置文件'
        : `打不开，文件在：${outcome.path}`)
    })
  }

  return createElement(
    'div',
    {
      ref: rootRef,
      tabIndex: -1,
      role: 'dialog',
      'aria-label': 'Vela board',
      'data-vela-panel': '',
    },
    createElement(
      'header',
      { 'data-vela-bar': '' },
      createElement('span', { 'data-vela-title': '' }, 'Vela'),
      createElement('span', { 'data-vela-spacer': '' }),
      ...(notice === undefined
        ? []
        : [createElement('span', { key: 'notice', 'data-vela-notice': '' }, notice)]),
      ...(nav === 'squads'
        ? []
        : [createElement(
          'label',
          { key: 'search', 'data-vela-search': '' },
          createElement('input', {
            type: 'search',
            value: query,
            placeholder: '找卡：编号、标题、描述',
            'aria-label': '搜索卡片',
            onChange: (event: { target: { value: string } }) => setQuery(event.target.value),
          }),
          // 命中数紧跟在输入框旁边：六列同时收窄时，「到底还剩几张」在列上很难数。
          ...(searching
            ? [createElement('span', { key: 'hits', 'data-vela-search-hits': '' }, `${visible.length} 张`)]
            : []),
        )]),
      ...(nav === 'squads'
        ? []
        : [createElement(
          'label',
          { key: 'filter', 'data-vela-filter': '' },
          'Workspace',
          createElement(
            'select',
            {
              value: workspace,
              style: { width: 'auto', maxWidth: '22rem' },
              'aria-label': 'filter by workspace',
              onChange: (event: { target: { value: string } }) => setWorkspace(event.target.value),
            },
            createElement('option', { key: ALL, value: ALL }, `全部（${workspaces.length}）`),
            ...workspaces.map(path => createElement('option', { key: path, value: path }, path)),
          ),
        )]),
      createElement('button', {
        type: 'button', onClick: () => { void refresh() }, 'aria-label': 'refresh',
      }, '刷新'),
      createElement('button', {
        type: 'button', onClick: () => panel.close(), 'aria-label': 'close',
      }, '关闭'),
    ),
    createElement(
      'div',
      { 'data-vela-body': '' },
      createElement(PanelSidebar, {
        current: nav,
        attention: attentionCount,
        onSelect: setNav,
        onClosePanel: () => panel.close(),
        onOpenDocument: openDocument,
      }),
      nav === 'squads'
        ? createElement(SquadsPage, {
          squads: view?.squads ?? [],
          canManage: view?.canManageSquads ?? false,
          sandboxPresets: view?.sandboxPresets ?? [],
          platform: view?.platform ?? 'linux',
          client,
          onChanged: refresh,
        })
        // 搜索无结果时不渲六条空泳道：那看起来像看板被清空了，而不是搜索没命中（票 11）。
        : searching && visible.length === 0
          ? createElement(
            'div',
            { 'data-vela-no-results': '' },
            createElement('p', undefined, `没有卡片匹配「${query.trim()}」。`),
            createElement(
              'p',
              { 'data-vela-muted': '' },
              '编号可以只打数字（比如 12），标题与描述是模糊匹配。',
            ),
            createElement('button', {
              type: 'button',
              onClick: () => setQuery(''),
            }, '清空搜索'),
            // 找历史会话是 DSH 自己的能力，不重画（ADR-0020）。而 DSH 没有给第三方插件
            // 的编程式跳页，所以这里能做的是把看板让开——dsh 的会话列表就在它底下。
            // 这不是一个死按钮：它真的把你送到能搜会话的地方，只是没能帮你把词带过去。
            createElement('button', {
              type: 'button',
              onClick: () => panel.close(),
              title: 'DSH 没有给插件的跳页接口，只能把看板让开',
            }, '去 DSH 找历史会话'),
          )
          : createElement(BoardGrid, {
            issues: visible,
            // 全部视图下每张卡片显示所属 Workspace；单一 Workspace 下那是冗余的。
            showWorkspace: workspace === ALL,
            // 建卡表单的默认 Workspace：筛选中的那个，否则最近用过的那个。
            defaultWorkspace: workspace === ALL ? workspaces[0] ?? '' : workspace,
            sandboxPresets: view?.sandboxPresets ?? [],
            squads: view?.squads ?? [],
            canDispatch: view?.canDispatch ?? false,
            liveUsage: view?.liveUsage ?? {},
            selectedId,
            onSelect: setSelectedId,
            openSession: props.openSession,
            client,
            onChanged: refresh,
          }),
      // 抽屉在 body 里作为右侧一列，而不是盖在 Board 上面的浮层：后者会把最右
      // 那几列（完成 / 失败）遮住，而那正是 Operator 验收时最想对着看的两列。
      ...(selected === undefined
        ? []
        : [createElement(IssueDrawer, {
          key: 'drawer',
          issue: selected,
          liveUsage: view?.liveUsage?.[selected.id],
          ...(view?.timelines === undefined ? {} : { timelines: view.timelines }),
          client,
          openSession: props.openSession,
          onChanged: refresh,
          onClose: () => setSelectedId(undefined),
        })]),
    ),
  )
}
