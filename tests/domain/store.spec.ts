/**
 * 快照持久化的行为契约。用真实临时目录，不 mock fs——原子发布、崩溃
 * 安全与写串行化这三件事全在文件系统的语义里，mock 掉就什么也没验证。
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyBoard } from '../../src/domain/types.ts'
import { createIssue } from '../../src/domain/board.ts'
import { BoardStore, StoreError, parse, serialize } from '../../src/domain/store.ts'

let dir: string
let path: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vela-store-'))
  path = join(dir, 'nested', 'board.json')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('serialize / parse', () => {
  it('往返保持等价', () => {
    const created = createIssue(emptyBoard(), { title: 'hello', workspace: '/w' }, 1, 'i1')
    assert.ok(created.ok)
    const board = created.value.board
    assert.deepEqual(parse(serialize(board)), board)
  })

  it('输出是人可读的缩进 JSON 且以换行结尾', () => {
    const text = serialize(emptyBoard())
    assert.ok(text.includes('\n  '), '应有缩进')
    assert.ok(text.endsWith('\n'), '应以换行结尾')
  })

  it('拒绝非 JSON', () => {
    assert.throws(() => parse('not json'), (error: unknown) => error instanceof StoreError && error.kind === 'malformed')
  })

  it('拒绝未知的 version', () => {
    assert.throws(() => parse('{"version":2,"issues":[]}'), (error: unknown) => error instanceof StoreError)
  })

  it('拒绝未知的 lane——手改错了要报错而不是静默丢卡片', () => {
    const bad = '{"version":1,"issues":[{"id":"a","title":"t","workspace":"/w","lane":"nope","priority":"none","position":1}]}'
    assert.throws(() => parse(bad), (error: unknown) => error instanceof StoreError && error.kind === 'malformed')
  })

  it('拒绝重复的 issue id', () => {
    const one = '{"id":"a","title":"t","workspace":"/w","lane":"todo","priority":"none","position":1}'
    assert.throws(
      () => parse(`{"version":1,"issues":[${one},${one}]}`),
      (error: unknown) => error instanceof StoreError && error.kind === 'malformed',
    )
  })

  it('缺省的可选字段被补齐而不是变成 undefined', () => {
    const bare = '{"version":1,"issues":[{"id":"a","title":"t","workspace":"/w","lane":"todo","priority":"none","position":1}]}'
    const board = parse(bare)
    const issue = board.issues[0]!
    assert.equal(issue.description, '')
    assert.equal(issue.maxAttempts, 0)
    assert.deepEqual(issue.exec, {})
    assert.deepEqual(issue.runs, [])
  })
})

describe('BoardStore.open', () => {
  it('拒绝相对路径——避免把用户数据散落在 cwd', async () => {
    await assert.rejects(
      () => BoardStore.open('relative/board.json'),
      (error: unknown) => error instanceof StoreError,
    )
  })

  it('文件不存在时给出空 Board，且不创建文件', async () => {
    const store = await BoardStore.open(path)
    assert.deepEqual(store.snapshot(), emptyBoard())
    await assert.rejects(() => readFile(path, 'utf8'))
  })

  it('重新打开能读回上次写入的内容', async () => {
    const first = await BoardStore.open(path)
    await first.mutate((board) => {
      const created = createIssue(board, { title: 'persisted', workspace: '/w' }, 1, 'i1')
      return created.ok ? { board: created.value.board, value: undefined } : undefined
    })
    const second = await BoardStore.open(path)
    assert.equal(second.snapshot().issues[0]?.title, 'persisted')
  })

  it('手工编辑过的文件能被正确加载', async () => {
    await mkdir(join(dir, 'nested'), { recursive: true })
    await writeFile(path, serialize(emptyBoard()), 'utf8')
    const store = await BoardStore.open(path)
    assert.deepEqual(store.snapshot(), emptyBoard())
  })
})

describe('BoardStore.mutate', () => {
  it('返回 undefined 表示放弃改动，不落盘', async () => {
    const store = await BoardStore.open(path)
    const result = await store.mutate(() => undefined)
    assert.equal(result, undefined)
    await assert.rejects(() => readFile(path, 'utf8'), '放弃的改动不应创建文件')
  })

  it('发布后不留下任何临时文件', async () => {
    const store = await BoardStore.open(path)
    await store.mutate((board) => {
      const created = createIssue(board, { title: 't', workspace: '/w' }, 1, 'i1')
      return created.ok ? { board: created.value.board, value: undefined } : undefined
    })
    const entries = await readdir(join(dir, 'nested'))
    assert.deepEqual(entries, ['board.json'], '临时文件必须已被 rename 掉')
  })

  it('并发 mutate 被串行化，不丢写入', async () => {
    const store = await BoardStore.open(path)
    // 十个并发写入。若读改写交错，先读到旧快照的那些会互相覆盖。
    await Promise.all(Array.from({ length: 10 }, (_, index) => store.mutate((board) => {
      const created = createIssue(board, { title: `c${index}`, workspace: '/w' }, index, `i${index}`)
      return created.ok ? { board: created.value.board, value: undefined } : undefined
    })))
    assert.equal(store.snapshot().issues.length, 10, '十次并发写入必须全部保留')
    const reopened = await BoardStore.open(path)
    assert.equal(reopened.snapshot().issues.length, 10, '落盘的内容也必须是十条')
  })

  it('发布失败时内存回滚，快照不被污染', async () => {
    const store = await BoardStore.open(path)
    await store.mutate((board) => {
      const created = createIssue(board, { title: 'good', workspace: '/w' }, 1, 'i1')
      return created.ok ? { board: created.value.board, value: undefined } : undefined
    })
    // 把目标路径变成目录：rename 覆盖它会失败。
    await rm(path)
    await mkdir(path, { recursive: true })
    const before = store.snapshot()
    await assert.rejects(() => store.mutate((board) => {
      const created = createIssue(board, { title: 'doomed', workspace: '/w' }, 2, 'i2')
      return created.ok ? { board: created.value.board, value: undefined } : undefined
    }))
    assert.deepEqual(store.snapshot(), before, '失败的写入不能留在内存里')
  })

  it('一次失败不会卡死后续写入', async () => {
    const store = await BoardStore.open(path)
    await rm(path, { force: true })
    await mkdir(path, { recursive: true })
    await assert.rejects(() => store.mutate(board => ({ board, value: undefined })))
    // 移除障碍后写链必须还能继续。
    await rm(path, { recursive: true, force: true })
    const value = await store.mutate(board => ({ board, value: 'recovered' }))
    assert.equal(value, 'recovered')
  })
})
