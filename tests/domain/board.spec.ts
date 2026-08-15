/**
 * Board 操作的行为契约。重点不是覆盖率，而是把 ADR 定下的不变量钉死，
 * 让日后任何「顺手改一下」的重构都会在这里红掉。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { emptyBoard } from '../../src/domain/types.ts'
import type { Board, Issue } from '../../src/domain/types.ts'
import {
  activeRun, createIssue, deleteIssue, gate, laneIssues, moveIssue,
  settleRun, shouldAutoRetry, startRun, updateIssue,
} from '../../src/domain/board.ts'
import type { BoardResult } from '../../src/domain/board.ts'

/** 从结果里取值，失败即让用例爆掉并带上原因。 */
function must<T>(result: BoardResult<T>): T {
  assert.ok(result.ok, result.ok ? '' : `expected ok, got ${result.code}: ${result.message}`)
  return result.value
}

let clock = 1000
function now(): number {
  clock += 1
  return clock
}

let seq = 0
function id(): string {
  seq += 1
  return `i${seq}`
}

/** 建一个带 n 张卡片的 Board，全部在 backlog。 */
function boardWith(count: number): { board: Board; ids: string[] } {
  let board = emptyBoard()
  const ids: string[] = []
  for (let i = 0; i < count; i += 1) {
    const issueId = id()
    board = must(createIssue(board, { title: `card ${i}`, workspace: '/w' }, now(), issueId)).board
    ids.push(issueId)
  }
  return { board, ids }
}

/** 把一张卡片推进到 review（派活 → 成功结束）。 */
function toReview(board: Board, issueId: string): Board {
  const started = must(startRun(board, issueId, { id: `r-${issueId}`, sessionId: `s-${issueId}` }, now()))
  const issue = started.issues.find(i => i.id === issueId)!
  return must(settleRun(started, issueId, { runId: activeRun(issue)!.id, outcome: 'completed' }, now()))
}

describe('createIssue', () => {
  it('新卡片落在 backlog 末尾', () => {
    const { board, ids } = boardWith(2)
    assert.deepEqual(laneIssues(board, 'backlog').map(i => i.id), ids)
  })

  it('maxAttempts 默认 0——不自动重试是刻意的默认值', () => {
    const { board } = boardWith(1)
    assert.equal(board.issues[0]!.maxAttempts, 0)
  })

  it('拒绝空标题', () => {
    const result = createIssue(emptyBoard(), { title: '   ', workspace: '/w' }, now(), id())
    assert.equal(result.ok, false)
    assert.equal(result.ok ? '' : result.code, 'invalid')
  })

  it('拒绝空 workspace', () => {
    const result = createIssue(emptyBoard(), { title: 't', workspace: '  ' }, now(), id())
    assert.equal(result.ok, false)
    assert.equal(result.ok ? '' : result.code, 'invalid')
  })

  it('拒绝负的 maxAttempts', () => {
    const result = createIssue(emptyBoard(), { title: 't', workspace: '/w', maxAttempts: -1 }, now(), id())
    assert.equal(result.ok, false)
    assert.equal(result.ok ? '' : result.code, 'invalid')
  })
})

describe('updateIssue', () => {
  it('只改给出的字段', () => {
    const { board, ids } = boardWith(1)
    const next = must(updateIssue(board, ids[0]!, { title: 'changed' }, now()))
    const issue = next.issues[0]!
    assert.equal(issue.title, 'changed')
    assert.equal(issue.workspace, '/w')
  })

  it('不存在的 Issue 报 not-found', () => {
    const result = updateIssue(emptyBoard(), 'nope', { title: 'x' }, now())
    assert.equal(result.ok, false)
    assert.equal(result.ok ? '' : result.code, 'not-found')
  })
})

describe('deleteIssue', () => {
  it('删掉后不再出现在 Board 上', () => {
    const { board, ids } = boardWith(2)
    const next = must(deleteIssue(board, ids[0]!))
    assert.deepEqual(next.issues.map(i => i.id), [ids[1]])
  })

  it('持有活 Run 时拒绝删除', () => {
    const { board, ids } = boardWith(1)
    const running = must(startRun(board, ids[0]!, { id: 'r1', sessionId: 's1' }, now()))
    const result = deleteIssue(running, ids[0]!)
    assert.equal(result.ok, false)
    assert.equal(result.ok ? '' : result.code, 'conflict')
  })
})

describe('Operator 拖拽的状态机边界', () => {
  it('backlog 与 todo 之间可自由移动', () => {
    const { board, ids } = boardWith(1)
    const toTodo = must(moveIssue(board, ids[0]!, { lane: 'todo' }, now()))
    assert.equal(toTodo.issues[0]!.lane, 'todo')
    const back = must(moveIssue(toTodo, ids[0]!, { lane: 'backlog' }, now()))
    assert.equal(back.issues[0]!.lane, 'backlog')
  })

  it('不能手动拖进 running——那只能由派活驱动', () => {
    const { board, ids } = boardWith(1)
    const result = moveIssue(board, ids[0]!, { lane: 'running' }, now())
    assert.equal(result.ok, false)
    assert.equal(result.ok ? '' : result.code, 'illegal-transition')
  })

  it('不能把卡片从 running 拖出去——活 Run 会变成孤儿', () => {
    const { board, ids } = boardWith(1)
    const running = must(startRun(board, ids[0]!, { id: 'r1', sessionId: 's1' }, now()))
    for (const lane of ['backlog', 'todo', 'review', 'done', 'failed'] as const) {
      const result = moveIssue(running, ids[0]!, { lane }, now())
      assert.equal(result.ok, false, `running → ${lane} 必须被拒绝`)
    }
  })

  it('不能从 failed 直达 done——绕过 Gate 会掏空把关点', () => {
    const { board, ids } = boardWith(1)
    const started = must(startRun(board, ids[0]!, { id: 'r1', sessionId: 's1' }, now()))
    const failed = must(settleRun(started, ids[0]!, { runId: 'r1', outcome: 'error' }, now()))
    assert.equal(failed.issues[0]!.lane, 'failed')
    const result = moveIssue(failed, ids[0]!, { lane: 'done' }, now())
    assert.equal(result.ok, false)
    assert.equal(result.ok ? '' : result.code, 'illegal-transition')
  })

  it('不能从 backlog 或 todo 直达 done', () => {
    const { board, ids } = boardWith(1)
    assert.equal(moveIssue(board, ids[0]!, { lane: 'done' }, now()).ok, false)
    const todo = must(moveIssue(board, ids[0]!, { lane: 'todo' }, now()))
    assert.equal(moveIssue(todo, ids[0]!, { lane: 'done' }, now()).ok, false)
  })

  it('同 Lane 内可按锚点重排', () => {
    const { board, ids } = boardWith(3)
    // 把第三张拖到第一张之前
    const next = must(moveIssue(board, ids[2]!, { lane: 'backlog', afterId: ids[0]! }, now()))
    assert.deepEqual(laneIssues(next, 'backlog').map(i => i.id), [ids[2], ids[0], ids[1]])
  })

  it('锚点不在目标 Lane 时报 not-found', () => {
    const { board, ids } = boardWith(2)
    const result = moveIssue(board, ids[0]!, { lane: 'todo', afterId: ids[1]! }, now())
    assert.equal(result.ok, false)
    assert.equal(result.ok ? '' : result.code, 'not-found')
  })

  it('精度耗尽时自动重整该 Lane，相对次序不变', () => {
    let { board, ids } = boardWith(2)
    // 反复往同一缝隙插入，直到必须重整。
    let moved = board
    for (let i = 0; i < 80; i += 1) {
      moved = must(moveIssue(moved, ids[1]!, { lane: 'backlog', beforeId: ids[0]! }, now()))
    }
    // 次序始终是 [ids[0], ids[1]]，且仍然可以继续插入。
    assert.deepEqual(laneIssues(moved, 'backlog').map(i => i.id), [ids[0], ids[1]])
  })
})

describe('Run 生命周期', () => {
  it('派活让卡片自动进 running', () => {
    const { board, ids } = boardWith(1)
    const next = must(startRun(board, ids[0]!, { id: 'r1', sessionId: 's1' }, now()))
    assert.equal(next.issues[0]!.lane, 'running')
    assert.equal(activeRun(next.issues[0]!)?.sessionId, 's1')
  })

  it('一个 Issue 同时只能有一个活 Run', () => {
    const { board, ids } = boardWith(1)
    const running = must(startRun(board, ids[0]!, { id: 'r1', sessionId: 's1' }, now()))
    const result = startRun(running, ids[0]!, { id: 'r2', sessionId: 's2' }, now())
    assert.equal(result.ok, false)
    assert.equal(result.ok ? '' : result.code, 'conflict')
  })

  it('★ Run 成功只到 review，永远不到 done', () => {
    const { board, ids } = boardWith(1)
    const reviewed = toReview(board, ids[0]!)
    assert.equal(reviewed.issues[0]!.lane, 'review')
  })

  it('Run 失败进 failed，且失败原因可读', () => {
    const { board, ids } = boardWith(1)
    const started = must(startRun(board, ids[0]!, { id: 'r1', sessionId: 's1' }, now()))
    const failed = must(settleRun(started, ids[0]!, { runId: 'r1', outcome: 'error', failure: 'boom' }, now()))
    assert.equal(failed.issues[0]!.lane, 'failed')
    assert.equal(failed.issues[0]!.runs[0]!.failure, 'boom')
  })

  it('每种非 completed 的结束原因都进 failed', () => {
    for (const outcome of ['aborted', 'blocked', 'error', 'max-tokens', 'interrupted', 'timeout'] as const) {
      const { board, ids } = boardWith(1)
      const started = must(startRun(board, ids[0]!, { id: 'r1', sessionId: 's1' }, now()))
      const settled = must(settleRun(started, ids[0]!, { runId: 'r1', outcome }, now()))
      assert.equal(settled.issues[0]!.lane, 'failed', `${outcome} 应进 failed`)
      assert.equal(settled.issues[0]!.runs[0]!.outcome, outcome)
    }
  })

  it('用量在结束时写入一次', () => {
    const { board, ids } = boardWith(1)
    const started = must(startRun(board, ids[0]!, { id: 'r1', sessionId: 's1' }, now()))
    const usage = {
      inputTokens: 10, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 1, reasoningTokens: 2,
    }
    const settled = must(settleRun(started, ids[0]!, { runId: 'r1', outcome: 'completed', usage }, now()))
    assert.deepEqual(settled.issues[0]!.runs[0]!.usage, usage)
  })

  it('异常终止导致用量缺失时保持 undefined，不伪造成 0', () => {
    const { board, ids } = boardWith(1)
    const started = must(startRun(board, ids[0]!, { id: 'r1', sessionId: 's1' }, now()))
    const settled = must(settleRun(started, ids[0]!, { runId: 'r1', outcome: 'interrupted' }, now()))
    assert.equal(settled.issues[0]!.runs[0]!.usage, undefined)
  })

  it('同一个 Run 不能结算两次', () => {
    const { board, ids } = boardWith(1)
    const started = must(startRun(board, ids[0]!, { id: 'r1', sessionId: 's1' }, now()))
    const settled = must(settleRun(started, ids[0]!, { runId: 'r1', outcome: 'completed' }, now()))
    const again = settleRun(settled, ids[0]!, { runId: 'r1', outcome: 'completed' }, now())
    assert.equal(again.ok, false)
    assert.equal(again.ok ? '' : again.code, 'conflict')
  })

  it('重新派活产生新 Run，但仍是同一个 Issue', () => {
    const { board, ids } = boardWith(1)
    const started = must(startRun(board, ids[0]!, { id: 'r1', sessionId: 's1' }, now()))
    const failed = must(settleRun(started, ids[0]!, { runId: 'r1', outcome: 'error' }, now()))
    const retried = must(startRun(failed, ids[0]!, { id: 'r2', sessionId: 's2' }, now()))
    assert.equal(retried.issues.length, 1)
    assert.equal(retried.issues[0]!.id, ids[0])
    assert.equal(retried.issues[0]!.runs.length, 2)
  })
})

describe('Gate', () => {
  it('接受后进 done', () => {
    const { board, ids } = boardWith(1)
    const reviewed = toReview(board, ids[0]!)
    const accepted = must(gate(reviewed, ids[0]!, 'accept', now()))
    assert.equal(accepted.issues[0]!.lane, 'done')
  })

  it('退回后回到 todo', () => {
    const { board, ids } = boardWith(1)
    const reviewed = toReview(board, ids[0]!)
    const rejected = must(gate(reviewed, ids[0]!, 'reject', now()))
    assert.equal(rejected.issues[0]!.lane, 'todo')
  })

  it('不在 review 的 Issue 无法被判定', () => {
    const { board, ids } = boardWith(1)
    const result = gate(board, ids[0]!, 'accept', now())
    assert.equal(result.ok, false)
    assert.equal(result.ok ? '' : result.code, 'illegal-transition')
  })

  it('★ done 只能从 review 到达——Gate 是通往终态的唯一入口', () => {
    const { board, ids } = boardWith(1)
    // 穷举所有非 review 的起点，确认没有一条路能直达 done。
    const lanes = ['backlog', 'todo', 'failed'] as const
    for (const lane of lanes) {
      let staged: Board = board
      if (lane === 'todo') staged = must(moveIssue(board, ids[0]!, { lane: 'todo' }, now()))
      if (lane === 'failed') {
        const started = must(startRun(board, ids[0]!, { id: 'rx', sessionId: 'sx' }, now()))
        staged = must(settleRun(started, ids[0]!, { runId: 'rx', outcome: 'error' }, now()))
      }
      assert.equal(
        moveIssue(staged, ids[0]!, { lane: 'done' }, now()).ok,
        false,
        `${lane} → done 必须被拒绝`,
      )
    }
  })
})

describe('自动重试策略', () => {
  it('默认 maxAttempts 0 时失败后不自动重试', () => {
    const { board, ids } = boardWith(1)
    const started = must(startRun(board, ids[0]!, { id: 'r1', sessionId: 's1' }, now()))
    const failed = must(settleRun(started, ids[0]!, { runId: 'r1', outcome: 'error' }, now()))
    assert.equal(shouldAutoRetry(failed.issues[0]!), false)
  })

  it('maxAttempts 大于 0 且未用尽时应重试', () => {
    let board = emptyBoard()
    const issueId = id()
    board = must(createIssue(board, { title: 't', workspace: '/w', maxAttempts: 2 }, now(), issueId)).board
    const started = must(startRun(board, issueId, { id: 'r1', sessionId: 's1' }, now()))
    const failed = must(settleRun(started, issueId, { runId: 'r1', outcome: 'error' }, now()))
    assert.equal(shouldAutoRetry(failed.issues[0]!), true)
  })

  it('用尽后停在 failed', () => {
    let board = emptyBoard()
    const issueId = id()
    board = must(createIssue(board, { title: 't', workspace: '/w', maxAttempts: 1 }, now(), issueId)).board
    let current: Board = board
    for (const runId of ['r1', 'r2']) {
      const started = must(startRun(current, issueId, { id: runId, sessionId: `s-${runId}` }, now()))
      current = must(settleRun(started, issueId, { runId, outcome: 'error' }, now()))
    }
    const issue: Issue = current.issues[0]!
    assert.equal(issue.runs.length, 2)
    assert.equal(shouldAutoRetry(issue), false)
  })
})
