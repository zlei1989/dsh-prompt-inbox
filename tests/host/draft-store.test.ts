import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
// 值导入写 .ts 后缀：本仓库用 tsx 直跑 TS，tsconfig 已开 allowImportingTsExtensions
// （要求 noEmit，已满足），tsc 与 tsx 都按同名 .ts 解析——与 src/ 的写法保持一致。
import { createDraftStore, foldRecords } from '../../src/host/draft-store.ts'
import type { DraftRecord } from '../../src/shared/types.ts'

function tempLog(): string {
  return join(mkdtempSync(join(tmpdir(), 'pi-')), 'prompt-inbox.jsonl')
}

function record(id: string, text = 'hello'): DraftRecord {
  return {
    id,
    createdAt: 1,
    originSessionId: 'sess-1',
    active: false,
    content: { text, attachments: [], elements: [] },
  }
}

test('foldRecords 取同 id 的最新一条', () => {
  const folded = foldRecords([
    JSON.stringify({ op: 'upsert', record: record('d1', 'first') }),
    JSON.stringify({ op: 'upsert', record: record('d1', 'second') }),
    JSON.stringify({ op: 'upsert', record: record('d2') }),
  ])
  assert.equal(folded.size, 2)
  assert.equal(folded.get('d1')?.content.text, 'second')
})

test('foldRecords 遇到坏行跳过而不整体崩', () => {
  const folded = foldRecords([
    'not json at all',
    JSON.stringify({ op: 'upsert', record: record('d1') }),
    '{"op":"upsert"',
    JSON.stringify({ op: 'wat' }),
  ])
  assert.equal(folded.size, 1)
  assert.ok(folded.has('d1'))
})

test('foldRecords 跳过 record 为 null 的 upsert 行', () => {
  const bad: number[] = []
  const folded = foldRecords(
    ['{"op":"upsert","record":null}', JSON.stringify({ op: 'upsert', record: record('d1') })],
    (b) => bad.push(b.line),
  )
  assert.equal(folded.size, 1)
  assert.ok(folded.has('d1'))
  assert.deepEqual(bad, [1], 'null 记录应被降级为坏行并告警，而不是抛出')
})

test('foldRecords 跳过缺字段的 upsert 行', () => {
  const bad: number[] = []
  const folded = foldRecords(
    [JSON.stringify({ op: 'upsert', record: record('d1', 'good') }), '{"op":"upsert","record":{"id":"d1"}}'],
    (b) => bad.push(b.line),
  )
  assert.deepEqual(bad, [2], '缺 content 的记录应被降级为坏行')
  assert.equal(folded.size, 1)
  assert.equal(folded.get('d1')?.content.text, 'good', '残缺记录不得进入状态覆盖已有记录')
})

test('appendUpsert 是纯追加，load 折叠出最新', () => {
  const logPath = tempLog()
  const store = createDraftStore({ logPath })
  store.appendUpsert(record('d1', 'first'))
  store.appendUpsert(record('d1', 'second'))
  const lines = readFileSync(logPath, 'utf8').trim().split('\n')
  assert.equal(lines.length, 2, '两次保存应是两行（纯追加）')
  assert.equal(store.load().length, 1)
  assert.equal(store.load()[0]?.content.text, 'second')
})

test('appendDelete 是墓碑，load 后记录消失', () => {
  const logPath = tempLog()
  const store = createDraftStore({ logPath })
  store.appendUpsert(record('d1'))
  store.appendDelete('d1', 2)
  assert.equal(store.load().length, 0)
})

test('load 对不存在的文件返回空数组（不抛）', () => {
  const store = createDraftStore({ logPath: tempLog() })
  assert.deepEqual(store.load(), [])
})

test('compact 重写为当前状态全集并保留未删除记录', () => {
  const logPath = tempLog()
  const store = createDraftStore({ logPath })
  store.appendUpsert(record('d1', 'first'))
  store.appendUpsert(record('d1', 'second'))
  store.appendUpsert(record('d2'))
  store.appendDelete('d2', 3)
  store.compact()
  const lines = readFileSync(logPath, 'utf8').trim().split('\n')
  assert.equal(lines.length, 1, '压紧后只应剩 d1 一行')
  assert.equal(store.load().length, 1)
  assert.equal(store.load()[0]?.content.text, 'second')
})

test('compact 走临时文件 + rename：临时文件被消费，目录里不留残余', () => {
  const logPath = tempLog()
  const store = createDraftStore({ logPath })
  store.appendUpsert(record('d1', 'second'))
  // 先落一个大文件，让「原地重写」在多数文件系统上不再是原子替换——
  // 若实现是原地写而非 temp+rename，下面的目录断言会失败
  writeFileSync(logPath, readFileSync(logPath, 'utf8') + 'x'.repeat(64 * 1024), 'utf8')
  const tempPath = join(dirname(logPath), '.' + 'prompt-inbox.jsonl.tmp')
  writeFileSync(tempPath, 'STALE-TEMP-SHOULD-BE-CONSUMED', 'utf8')
  store.compact()
  assert.equal(existsSync(tempPath), false, 'temp 文件必须被 rename 消费掉，不能留下')
  const siblings = readdirSync(dirname(logPath))
  assert.deepEqual(siblings, ['prompt-inbox.jsonl'], '目录里只应剩日志文件本身')
  const raw = readFileSync(logPath, 'utf8')
  assert.ok(raw.startsWith('{"op":"upsert"'), '压紧后应只含 upsert 记录')
  assert.ok(raw.endsWith('\n'), '压紧后的文件应以换行收尾')
  assert.equal(store.load().length, 1)
})

test('recordCount 统计尚未压紧的行数', () => {
  const logPath = tempLog()
  const store = createDraftStore({ logPath })
  store.appendUpsert(record('d1'))
  store.appendUpsert(record('d2'))
  assert.equal(store.recordCount(), 2)
})

test('load 忽略已损坏的尾部半行', () => {
  const logPath = tempLog()
  const store = createDraftStore({ logPath })
  store.appendUpsert(record('d1'))
  writeFileSync(logPath, readFileSync(logPath, 'utf8') + '{"op":"upsert","rec', 'utf8')
  assert.equal(store.load().length, 1)
})
