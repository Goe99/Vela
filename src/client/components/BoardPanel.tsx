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
import { BoardGrid } from './BoardGrid.tsx'

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

  // Escape 关闭。只在打开时挂 listener，关闭即摘。
  useEffect(() => {
    if (!isOpen) return undefined
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') panel.close()
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [isOpen, panel])

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

  const visible = workspace === ALL
    ? view?.board.issues ?? []
    : (view?.board.issues ?? []).filter(issue => issue.workspace === workspace)

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
      // Multica License 条件 (b)：移植的看板 UI 必须保留 Multica 署名。
      createElement('span', { 'data-vela-brand': '' }, 'Powered by Multica'),
      createElement('span', { 'data-vela-spacer': '' }),
      createElement(
        'label',
        { 'data-vela-filter': '' },
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
      ),
      createElement('button', {
        type: 'button', onClick: () => { void refresh() }, 'aria-label': 'refresh',
      }, '刷新'),
      createElement('button', {
        type: 'button', onClick: () => panel.close(), 'aria-label': 'close',
      }, '关闭'),
    ),
    createElement(BoardGrid, {
      issues: visible,
      // 全部视图下每张卡片显示所属 Workspace；单一 Workspace 下那是冗余的。
      showWorkspace: workspace === ALL,
      // 建卡表单的默认 Workspace：筛选中的那个，否则最近用过的那个。
      defaultWorkspace: workspace === ALL ? workspaces[0] ?? '' : workspace,
      sandboxPresets: view?.sandboxPresets ?? [],
      canDispatch: view?.canDispatch ?? false,
      liveUsage: view?.liveUsage ?? {},
      openSession: props.openSession,
      client,
      onChanged: refresh,
    }),
  )
}
