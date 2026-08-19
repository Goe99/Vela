/**
 * 记忆页：这个部署攒下的全部复盘，按工作区分组的只读浏览 + 删除。
 *
 * 形态向技能广场看齐：一个工作区一列，一篇复盘是一张**紧凑卡**——信任标记、
 * 标题、落盘日期；完整正文收进点开的弹窗里。
 *
 * 三种状态必须分清（这一页最容易做错的地方）：
 * - **没开启**：没配 `memoryPath`，这个功能根本没跑（ADR-0022）
 * - **拉取失败**：接口挂了，该重试
 * - **一篇都没有**：开着、能读，只是还没攒下东西
 *
 * 混成一个空列表会让 Operator 以为「记忆功能不好使」，而实情可能是他没开。
 *
 * 纯展示组件——数据与拉取时机都由 BoardPanel 持有。
 */

import { createElement, useEffect, useState } from 'react'
import type { MemoryEntryView, MemoryView } from '../../domain/okf-bundle.ts'
import { trustMark } from '../../domain/okf-bundle.ts'
import { avatarChar, memberHue } from './MemberEditor.tsx'

/** 记忆页的 props。 */
export interface MemoryPageProps {
  /** undefined = 拉取失败（failed 为真）或还没拉过。 */
  readonly view?: MemoryView
  /** 上一次拉取失败过：显示成「拉取失败 + 重试」，而不是空列表。 */
  readonly failed: boolean
  readonly loading: boolean
  onRefresh(): void
  /** 删一篇。删除留痕由后端记进更新历史。 */
  onRemove(path: string): void
}

/** 一篇复盘的详情弹窗。 */
export interface RecapDialogProps {
  readonly entry: MemoryEntryView
  readonly onClose: () => void
  readonly onRemove: (path: string) => void
}

/** 一篇的徽章：信任等级、废弃、陈旧、被召回过几次。 */
function recapChips(entry: MemoryEntryView): ReturnType<typeof createElement>[] {
  return [
    createElement('span', {
      key: 'trust',
      'data-vela-chip': '',
      'data-tone': entry.trust === 'human-reviewed' ? 'good' : 'medium',
      title: entry.trust === 'human-reviewed'
        ? '验收时经人审过，可以被召回'
        : '还没人审过，不会被召回',
    }, trustMark(entry.trust)),
    ...(entry.status === 'deprecated'
      ? [createElement('span', { key: 'dep', 'data-vela-chip': '', 'data-tone': 'medium', title: '被更晚的执行取代，或验收时判定不值得留' }, '已废弃')]
      : []),
    ...(entry.stale
      ? [createElement('span', { key: 'stale', 'data-vela-chip': '', 'data-tone': 'warn', title: '过了保鲜期，不再参与召回' }, '已陈旧')]
      : []),
    ...(entry.usageCount > 0
      ? [createElement('span', { key: 'use', 'data-vela-chip': '', title: '被召回展开过几次' }, `用过 ${entry.usageCount} 次`)]
      : []),
  ]
}

/** 详情弹窗：整篇正文，加一个删除入口。 */
export function RecapDialog(props: RecapDialogProps): ReturnType<typeof createElement> {
  const { entry, onClose, onRemove } = props
  const [confirming, setConfirming] = useState(false)

  // Esc 关弹窗。捕获阶段拦下并阻止传播：面板在 window 冒泡阶段挂了全局
  // 「Esc 关面板」，不拦会连面板一起关（与技能详情弹窗同款处理）。
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // onClose 只调 setState，setter 稳定，空依赖安全。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return createElement(
    'div',
    { 'data-vela-modal-backdrop': '', onClick: onClose },
    createElement(
      'div',
      {
        'data-vela-modal': '',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': `复盘 ${entry.title}`,
        onClick: (event: { stopPropagation(): void }) => event.stopPropagation(),
      },
      createElement(
        'header',
        { 'data-vela-modal-head': '' },
        createElement('span', { 'data-vela-recap-dialog-title': '' }, entry.title, ...recapChips(entry)),
        createElement('button', {
          type: 'button',
          'data-vela-icon-btn': '',
          'aria-label': '关闭',
          onClick: onClose,
        }, '✕'),
      ),
      createElement(
        'div',
        { 'data-vela-modal-body': '' },
        ...(entry.problem === undefined
          ? []
          : [createElement('div', { key: 'prob', 'data-vela-recap-problem': '' }, `⚠ 这篇读不了：${entry.problem}`)]),
        createElement('div', { 'data-vela-recap-field': '' },
          createElement('div', { 'data-vela-recap-field-label': '' }, '文件'),
          createElement('div', { 'data-vela-recap-path': '' }, entry.path)),
        ...(entry.workspace === undefined
          ? []
          : [createElement('div', { key: 'ws', 'data-vela-recap-field': '' },
            createElement('div', { 'data-vela-recap-field-label': '' }, '工作区'),
            createElement('div', { 'data-vela-recap-path': '' }, entry.workspace))]),
        createElement('div', { 'data-vela-recap-field': '' },
          createElement('div', { 'data-vela-recap-field-label': '' }, '落盘'),
          createElement('div', null, entry.generatedAt ?? '未记录')),
        ...(entry.verifiedAt === undefined
          ? []
          : [createElement('div', { key: 'vf', 'data-vela-recap-field': '' },
            createElement('div', { 'data-vela-recap-field-label': '' }, '人审'),
            createElement('div', null, entry.verifiedAt))]),
        ...(entry.body.length === 0
          ? []
          : [createElement('pre', { key: 'body', 'data-vela-recap-body': '' }, entry.body)]),
      ),
      createElement(
        'footer',
        { 'data-vela-modal-foot': '' },
        confirming
          ? createElement(
            'span',
            { 'data-vela-recap-confirm': '' },
            '删掉这篇？更新历史里会留一行。',
            createElement('button', {
              type: 'button',
              'data-tone': 'danger',
              onClick: () => { onRemove(entry.path); onClose() },
            }, '确认删除'),
            createElement('button', { type: 'button', onClick: () => setConfirming(false) }, '算了'),
          )
          : createElement('button', {
            type: 'button',
            'data-tone': 'danger',
            onClick: () => setConfirming(true),
          }, '删除'),
      ),
    ),
  )
}

/** 一篇的紧凑卡。 */
function recapCard(
  entry: MemoryEntryView,
  onOpen: (entry: MemoryEntryView) => void,
): ReturnType<typeof createElement> {
  return createElement(
    'div',
    {
      key: entry.path,
      'data-vela-recap-row': '',
      'data-dim': String(entry.status === 'deprecated' || entry.stale),
      role: 'button',
      tabIndex: 0,
      'aria-label': `复盘 ${entry.title}，点开看全文`,
      onClick: () => onOpen(entry),
      onKeyDown: (event: { key: string }) => {
        if (event.key === 'Enter' || event.key === ' ') onOpen(entry)
      },
    },
    createElement('span', {
      'data-vela-avatar': '',
      'data-hue': String(memberHue(entry.title)),
      'aria-hidden': 'true',
    }, avatarChar(entry.title)),
    createElement('div', { 'data-vela-recap-main': '' },
      createElement('div', { 'data-vela-recap-title': '' }, entry.title, ...recapChips(entry)),
      entry.problem !== undefined
        ? createElement('div', { 'data-vela-recap-problem': '' }, `⚠ 这篇读不了：${entry.problem}`)
        : createElement('div', { 'data-vela-recap-when': '' },
          entry.generatedAt === undefined ? entry.path : entry.generatedAt.slice(0, 10))),
  )
}

/** 一个工作区一列。 */
function workspaceColumn(
  workspace: string,
  entries: readonly MemoryEntryView[],
  onOpen: (entry: MemoryEntryView) => void,
): ReturnType<typeof createElement> {
  const reviewed = entries.filter(entry => entry.trust === 'human-reviewed').length
  return createElement(
    'section',
    { key: workspace, 'data-vela-recap-col': '' },
    createElement('header', { 'data-vela-recap-col-head': '' },
      createElement('h3', null, `${workspace}（${entries.length}）`),
      createElement('div', { 'data-vela-recap-hint': '' }, `${reviewed} 篇人审过，可被召回`)),
    createElement(
      'div',
      { 'data-vela-recap-col-body': '' },
      ...entries.map(entry => recapCard(entry, onOpen)),
    ),
  )
}

/** 记忆页。 */
export function MemoryPage(props: MemoryPageProps): ReturnType<typeof createElement> {
  const { view, failed, loading, onRefresh, onRemove } = props
  const [selected, setSelected] = useState<MemoryEntryView | undefined>(undefined)

  const head = createElement(
    'div',
    { 'data-vela-recap-head': '' },
    createElement('h2', null, '记忆'),
    ...(view === undefined || !view.available
      ? []
      : [createElement('span', { key: 'n', 'data-vela-chip': '' }, `${view.entries.length} 篇`)]),
    createElement('button', {
      type: 'button',
      disabled: loading,
      onClick: onRefresh,
      'aria-label': '刷新记忆列表',
    }, loading ? '在读…' : '刷新'),
  )

  if (failed && view === undefined) {
    return createElement(
      'div',
      { 'data-vela-memory': '' },
      head,
      createElement('div', { 'data-vela-error': '' }, '记忆列表拉取失败。点「刷新」重试。'),
    )
  }

  if (view === undefined) {
    return createElement(
      'div',
      { 'data-vela-memory': '' },
      head,
      createElement('div', { 'data-vela-empty': '' }, '正在读记忆库…'),
    )
  }

  // 没开启与「一篇都没有」必须分开说：前者要给开启办法，后者只是还没攒下。
  if (!view.available) {
    return createElement(
      'div',
      { 'data-vela-memory': '' },
      head,
      createElement('div', { 'data-vela-empty': '' },
        '记忆库没开启。给 Vela 配上 memoryPath（一个绝对路径）之后，'
        + '每次执行结束会在那里落一篇复盘，验收时你可以顺手裁定它可不可信。'),
    )
  }

  if (view.entries.length === 0) {
    return createElement(
      'div',
      { 'data-vela-memory': '' },
      head,
      createElement('div', { 'data-vela-empty': '' },
        '还没有复盘。派一张卡、等它跑完，这里就会出现第一篇。'),
    )
  }

  // 按工作区分组。没记工作区的旧文件归到一起，而不是丢掉。
  const groups = new Map<string, MemoryEntryView[]>()
  for (const entry of view.entries) {
    const key = entry.workspace ?? '（未记录工作区）'
    const group = groups.get(key) ?? []
    group.push(entry)
    groups.set(key, group)
  }

  return createElement(
    'div',
    { 'data-vela-memory': '' },
    head,
    createElement(
      'div',
      { 'data-vela-recap-cols': '' },
      ...[...groups].map(([workspace, entries]) => workspaceColumn(workspace, entries, setSelected)),
    ),
    ...(view.history.length === 0
      ? []
      : [createElement(
        'details',
        { key: 'log', 'data-vela-recap-log': '' },
        createElement('summary', null, `更新历史（${view.history.length} 条）`),
        createElement(
          'ul',
          null,
          ...view.history.slice(0, 50).map((line, at) =>
            createElement('li', { key: at }, line)),
        ),
      )]),
    createElement('div', { 'data-vela-recap-footer': '' },
      '只有「人审过」且未废弃未陈旧的复盘会在派活时被带给 Agent。'
      + '这些文件是普通 Markdown，可以直接改、可以整个目录拷走。'),
    ...(selected === undefined
      ? []
      : [createElement(RecapDialog, {
        key: 'detail',
        entry: selected,
        onClose: () => setSelected(undefined),
        onRemove,
      })]),
  )
}
