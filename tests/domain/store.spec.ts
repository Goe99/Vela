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
    assert.throws(() => parse('{"version":99,"issues":[]}'), (error: unknown) => error instanceof StoreError)
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

describe('编号迁移', () => {
  const issue = (id: string, createdAt: number, extra = ''): string =>
    `{"id":"${id}","title":"${id}","workspace":"/w","lane":"todo","priority":"none","position":1,"createdAt":${createdAt},"updatedAt":${createdAt}${extra}}`

  it('版本 1 的旧快照被补上编号，顺序按创建时间而非文件里的位置', () => {
    // 文件里故意倒序：若按位置发号，late 会拿到 1。
    const board = parse(`{"version":1,"issues":[${issue('late', 900)},${issue('early', 100)}]}`)
    const numbers = new Map(board.issues.map(i => [i.id, i.number]))
    assert.equal(numbers.get('early'), 1)
    assert.equal(numbers.get('late'), 2)
    assert.equal(board.version, 2)
    assert.equal(board.nextNumber, 3)
  })

  it('同一份旧快照读两次得到完全相同的编号', () => {
    const text = `{"version":1,"issues":[${issue('b', 5)},${issue('a', 5)},${issue('c', 1)}]}`
    assert.deepEqual(parse(text), parse(text))
    // 同时间戳时用 id 打平手，因此 a 先于 b。
    const numbers = new Map(parse(text).issues.map(i => [i.id, i.number]))
    assert.deepEqual([numbers.get('c'), numbers.get('a'), numbers.get('b')], [1, 2, 3])
  })

  it('部分有编号的快照，只补缺的那些且不撞号', () => {
    const board = parse(`{"version":2,"nextNumber":8,"issues":[${issue('kept', 1, ',"number":7')},${issue('fresh', 2)}]}`)
    const numbers = new Map(board.issues.map(i => [i.id, i.number]))
    assert.equal(numbers.get('kept'), 7, '已有编号不能被改')
    assert.equal(numbers.get('fresh'), 1, '补号取最小可用正整数')
  })

  it('全部有编号的快照原样保留', () => {
    const text = `{"version":2,"nextNumber":42,"issues":[${issue('a', 1, ',"number":3')},${issue('b', 2, ',"number":9')}]}`
    const board = parse(text)
    assert.deepEqual(board.issues.map(i => i.number), [3, 9])
    assert.equal(board.nextNumber, 42, '文件声明的计数器优先——它记得住退役的编号')
  })

  it('声明的计数器低于现有最大值时被抬高，不能让下一张卡撞号', () => {
    const board = parse(`{"version":2,"nextNumber":2,"issues":[${issue('a', 1, ',"number":9')}]}`)
    assert.equal(board.nextNumber, 10)
  })

  it('重复编号报错而不是静默重分——编号是对外引用的句柄', () => {
    assert.throws(
      () => parse(`{"version":2,"issues":[${issue('a', 1, ',"number":4')},${issue('b', 2, ',"number":4')}]}`),
      (error: unknown) => error instanceof StoreError && error.kind === 'malformed',
    )
  })

  it('拒绝非正整数的编号', () => {
    for (const bad of ['0', '-1', '1.5']) {
      assert.throws(
        () => parse(`{"version":2,"issues":[${issue('a', 1, `,"number":${bad}`)}]}`),
        (error: unknown) => error instanceof StoreError && error.kind === 'malformed',
        `number=${bad} 应被拒绝`,
      )
    }
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

  it('版本 1 的旧快照在打开时就被升级并落盘', async () => {
    await mkdir(join(dir, 'nested'), { recursive: true })
    const old = '{"version":1,"issues":[{"id":"a","title":"t","workspace":"/w","lane":"todo","priority":"none","position":1,"createdAt":1,"updatedAt":1}]}'
    await writeFile(path, old, 'utf8')
    const store = await BoardStore.open(path)
    assert.equal(store.snapshot().issues[0]?.number, 1)
    const onDisk = await readFile(path, 'utf8')
    assert.ok(onDisk.includes('"version": 2'), '升级结果必须已经写回磁盘')
    assert.ok(onDisk.includes('"number": 1'))
  })

  it('已经是当前版本且规范的文件不被重写', async () => {
    await mkdir(join(dir, 'nested'), { recursive: true })
    const created = createIssue(emptyBoard(), { title: 't', workspace: '/w' }, 1, 'i1')
    if (!created.ok) throw new Error(created.message)
    await writeFile(path, serialize(created.value.board), 'utf8')
    const before = await readFile(path, 'utf8')
    await BoardStore.open(path)
    assert.equal(await readFile(path, 'utf8'), before, '已规范的文件不应被动')
  })

  // 没有「写回失败仍能打开」的测试：跟跨平台地造一个「读得进、写不进」的
  // 目录在 Windows 上不可靠（chmod 基本是空操作）。那条回退路径的安全性完全
  // 建立在升级的**确定性**上，而确定性有测试盖着（见「同一份旧快照读两次
  // 得到完全相同的编号」）——只要那一条成立，没落盘就只是下次重做一次。
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
