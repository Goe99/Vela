/**
 * 会话头部的「提取待办」按钮与它的候选清单（票 13）。
 *
 * 这是 Vela 唯一一个挂在**会话作用域**的界面：Board 面板挂在最外层，定义上不知道
 * 「当前会话」是哪个，所以「把刚讨论的事变成卡片」这件事只能在这里做。
 *
 * 三个数据都从框架给的标准 props 来，不额外走网络：
 * - 会话 id：框架直接给 `sessionId`
 * - 消息文本：`useSession()` 拿到的快照里的 `nodes`
 * - 工作目录：会话列表里那一行的 `cwd`
 *
 * **一个诚实的限制**：`nodes` 只覆盖当前已加载的那一扇窗口。客户端没有能读完整
 * 历史的接口（那是宿主侧的 API），所以往前滚过很远的长会话会漏掉早期的待办。
 * 快照的 `hasMore` 会告诉我们这种情况，界面上如实写出来，而不是默默少捞几条。
 */

import { createElement, useState } from 'react'
import type { SessionSlotProps, ConversationNodeLike, SessionsNav } from '../dsh-client.ts'
import { extractCandidates } from '../../domain/extract.ts'
import type { BoardClient } from '../board-client.ts'

/** 这个 slot entry 的注入面。 */
export interface ExtractInjected {
  readonly client: BoardClient
  /** 会话服务，用来查这个会话的工作目录。 */
  readonly sessions: SessionsNav
  /** 建卡成功后刷新看板，卡才会在面板里出现。 */
  readonly onCreated: () => void
}

/** 组件收到的 props：注入面铺平 + 框架给的会话标准件。 */
export type SessionExtractProps = ExtractInjected & SessionSlotProps

/** 从一个节点里取出纯文本。 */
function textOf(node: ConversationNodeLike): string {
  // 用户消息把块放在 content 里，助手消息放在 blocks 里。两个字段名不同，
  // 但里面都是块，所以合起来扫。
  const blocks = [...node.content ?? [], ...node.blocks ?? []]
  return blocks
    // 助手块用 kind、用户块用 type，两种都认。reasoning 块要排掉——模型的
    // 内心独白里全是「我应该先……」，那不是 Operator 要的待办。
    .filter(block => (block.kind ?? block.type) === 'text' || block.kind === undefined && block.type === 'text')
    .map(block => block.text ?? '')
    .join('\n')
}

/** 会话头部的提取按钮。 */
export function SessionExtract(props: SessionExtractProps): ReturnType<typeof createElement> {
  const { client, sessions, sessionId, useSession, onCreated } = props
  const [open, setOpen] = useState(false)
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | undefined>(undefined)

  // 只在展开时才去扫消息：这个 hook 每次快照变化都会重算，而会话跑起来时
  // 快照是每个 token 都在变的。
  const texts = useSession(snapshot => (open
    ? (snapshot.nodes ?? []).map(textOf).filter(text => text.trim().length > 0)
    : []))
  const truncated = useSession(snapshot => snapshot.hasMore === true)
  const candidates = extractCandidates(texts)

  // 工作目录：会话列表里那一行的 cwd。取不到时不猜——让 Operator 自己在
  // 看板里填，比默认落到一个错的仓库上安全。
  const workspace = sessions.list?.get?.()?.byId?.[sessionId]?.cwd

  const toggle = (title: string): void => {
    setPicked((current) => {
      const next = new Set(current)
      if (next.has(title)) next.delete(title)
      else next.add(title)
      return next
    })
  }

  const create = async (): Promise<void> => {
    if (workspace === undefined || picked.size === 0) return
    setBusy(true)
    setProblem(undefined)
    // 按候选原本的顺序建，不按勾选顺序——Operator 勾的次序是随机的，
    // 而候选顺序是讨论时的顺序，那个更有意义。
    const titles = candidates.map(one => one.title).filter(title => picked.has(title))
    const result = await client.createBatch(workspace, titles)
    setBusy(false)
    if (result.ok !== true) {
      setProblem(result.message)
      return
    }
    setPicked(new Set())
    setOpen(false)
    onCreated()
  }

  if (!open) {
    return createElement(
      'button',
      {
        type: 'button',
        onClick: () => setOpen(true),
        'data-vela-extract-open': '',
        title: '把这次讨论里的待办提取成卡片',
      },
      '提取待办',
    )
  }

  return createElement(
    'div',
    { 'data-vela-extract': '' },
    createElement(
      'div',
      { 'data-vela-extract-head': '' },
      createElement('strong', undefined, `提取待办（${candidates.length}）`),
      createElement(
        'button',
        { type: 'button', onClick: () => setOpen(false), 'aria-label': '收起' },
        '×',
      ),
    ),

    // 工作目录取不到时说清楚，而不是让「建卡」按钮死在那里没有解释。
    workspace === undefined
      ? createElement('div', { 'data-vela-extract-note': '', 'data-tone': 'warn' },
        '这个会话没有记下工作目录，没法自动决定卡片归哪个仓库。请在看板里手动建卡。')
      : createElement('div', { 'data-vela-extract-note': '' }, `建到：${workspace}`),

    // 只看到一部分历史时如实说明。这是客户端接口的限制，不是 bug。
    truncated
      ? createElement('div', { 'data-vela-extract-note': '', 'data-tone': 'warn' },
        '只扫了当前已加载的消息。更早的内容需要先在会话里往上滚，让它加载出来。')
      : undefined,

    candidates.length === 0
      ? createElement('div', { 'data-vela-extract-empty': '' },
        '没找到清单形式的待办。提取只认「- 」「1. 」这类列表行——散文里的事得自己建卡。')
      : createElement(
        'ul',
        { 'data-vela-extract-list': '' },
        ...candidates.map(candidate => createElement(
          'li',
          { key: candidate.title },
          createElement(
            'label',
            undefined,
            createElement('input', {
              type: 'checkbox',
              checked: picked.has(candidate.title),
              onChange: () => toggle(candidate.title),
            }),
            createElement('span', undefined, candidate.title),
          ),
        )),
      ),

    problem === undefined
      ? undefined
      : createElement('div', { 'data-vela-extract-note': '', 'data-tone': 'bad' }, problem),

    createElement(
      'div',
      { 'data-vela-extract-foot': '' },
      createElement(
        'button',
        {
          type: 'button',
          disabled: busy || picked.size === 0 || workspace === undefined,
          onClick: () => { void create() },
          'data-vela-extract-create': '',
        },
        busy ? '正在建…' : `建 ${picked.size} 张卡`,
      ),
      candidates.length === 0
        ? undefined
        : createElement(
          'button',
          {
            type: 'button',
            onClick: () => setPicked(picked.size === candidates.length
              ? new Set()
              : new Set(candidates.map(one => one.title))),
          },
          picked.size === candidates.length ? '全不选' : '全选',
        ),
    ),
  )
}
