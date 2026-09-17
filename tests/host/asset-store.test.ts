import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { createAssetStore, refToPath, shardRef } from '../../src/host/asset-store.ts'

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'pi-assets-'))
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])

const h = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/**
 * 与 PNG 同分片（sha256 前2位均为 `cd`，见下方断言）的另一份内容，
 * 用于验证「同分片下不同内容各占一份」。
 */
const OTHER = new Uint8Array([9, 9, 9, 161, 0])

test('shardRef 按内容哈希分片', () => {
  const ref = shardRef('9f2cabcdef')
  // 断言字面量而非 path.join：ref 会被持久化进 jsonl，必须与平台无关
  assert.equal(ref, 'sha256/9f/9f2cabcdef.bin')
  assert.ok(!ref.includes('\\'), 'ref 不得含平台分隔符，否则换平台后匹配不上')
})

test('ref 在重新计算后仍然命中：put → has → read → collectGarbage', () => {
  const root = tempRoot()
  const store = createAssetStore({ root })
  const put = store.put(PNG)
  const ref = shardRef(put.sha256)
  assert.ok(store.has(ref), '重新计算的 ref 必须命中（jsonl 里存的就是这个字符串）')
  assert.deepEqual([...store.read(ref)], [...PNG])
  assert.equal(store.collectGarbage(new Set([ref])), 0, '被引用的 ref 不得被回收')
  assert.ok(store.has(ref))
})

test('refToPath 把逻辑 ref 转成本机路径（逻辑标识与文件系统路径的唯一边界）', () => {
  const root = tempRoot()
  const sha = h(PNG)
  const ref = shardRef(sha)
  const path = refToPath(root, ref)

  // 语义形状写死：root + sha256 + <前2位> + <sha256>.bin
  assert.equal(dirname(path), join(root, 'sha256', sha.slice(0, 2)))
  assert.equal(basename(path), sha + '.bin')
  if (sep === '\\') {
    assert.ok(!path.includes('/'), '本机路径不得混入逻辑分隔符')
  }

  // 「同一 ref ⇒ 同一文件」是 put / read / has 得以互认的前提：
  // 两个写法不同但规范等价于同一个 ref 的字符串必须落到同一个文件上，
  // 否则同一份资产会被读成两份。
  assert.equal(refToPath(root, ref), refToPath(root, '.' + '/' + ref))
})

test('put 落盘并返回 sha256 与 ref', () => {
  const store = createAssetStore({ root: tempRoot() })
  const put = store.put(PNG)
  assert.equal(put.bytes, PNG.byteLength)
  assert.match(put.sha256, /^[0-9a-f]{64}$/)
  assert.ok(store.has(put.ref))
})

test('相同内容只落一份（去重）', async () => {
  const root = tempRoot()
  const store = createAssetStore({ root })
  const a = store.put(PNG)
  const ref = shardRef(a.sha256)
  const target = refToPath(root, ref)

  // 同上：纯函数性质的断言观测不到磁盘
  assert.equal(a.sha256, h(PNG))

  // 落盘形状：分片目录里恰好一份、文件名即内容哈希、字节数与内容都对
  const shardDir = dirname(target)
  assert.deepEqual(readdirSync(shardDir), [a.sha256 + '.bin'])
  assert.equal(statSync(target).size, PNG.byteLength)
  assert.deepEqual([...readFileSync(target)], [...PNG], '磁盘上的那份就是输入的字节')

  // 关键断言：第二次 put 必须真的跳过写入。
  // 让 mtime 先有机会变化，再用「mtime 未变」观测「没有发生第二次写」——
  // 若 put 无条件重写，文件数与大小都仍是对的，只有 mtime 会暴露它。
  await sleep(20)
  const before = statSync(target).mtimeMs
  const b = store.put(PNG)
  assert.equal(b.ref, a.ref)
  assert.equal(b.sha256, a.sha256)
  assert.equal(statSync(target).mtimeMs, before, '同内容第二次 put 不得重写文件')

  // 反向可证伪：同分片内的不同内容必须落成第二个文件。
  // 用同分片样本是刻意的——不同内容通常散在不同分片，那样「第二个文件」根本无从观测；
  // 先把同分片这一前提本身断言出来，样本若漂移则在此处响亮失败，而不是让断言悄悄变弱。
  assert.equal(shardRef(h(OTHER)).slice(0, 10), shardRef(h(PNG)).slice(0, 10), '样本须与 PNG 同分片')
  store.put(OTHER)
  assert.equal(readdirSync(shardDir).length, 2, '同分片内不同内容必须落成第二个文件')
})

test('read 取回原始字节', () => {
  const store = createAssetStore({ root: tempRoot() })
  const put = store.put(PNG)
  assert.deepEqual([...store.read(put.ref)], [...PNG])
})

test('has 对不存在的 ref 返回 false', () => {
  const store = createAssetStore({ root: tempRoot() })
  assert.equal(store.has(join('sha256', 'zz', 'zz.bin')), false)
})

test('collectGarbage 只删除未被引用的资产', () => {
  const root = tempRoot()
  const store = createAssetStore({ root })
  const keep = store.put(PNG)
  const drop = store.put(new Uint8Array([9, 9, 9]))
  const removed = store.collectGarbage(new Set([keep.ref]))
  assert.equal(removed, 1)
  assert.ok(store.has(keep.ref), '被引用的资产必须保留')
  assert.equal(store.has(drop.ref), false, '无引用资产必须删除')
})

test('collectGarbage 对空目录返回 0', () => {
  const store = createAssetStore({ root: tempRoot() })
  assert.equal(store.collectGarbage(new Set()), 0)
})
