import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDraftStore } from '../../src/host/draft-store.ts'
import { createAssetStore, shardRef } from '../../src/host/asset-store.ts'
import { createDraftService, extractElementIds } from '../../src/host/draft-service.ts'
import type { DraftElementRecord, DraftSavePayload } from '../../src/shared/types.ts'

function harness(overrides: { maxAttachmentBytes?: number; maxDraftBytes?: number; maxRecords?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pi-svc-'))
  const store = createDraftStore({ logPath: join(root, 'prompt-inbox.jsonl') })
  const assets = createAssetStore({ root: join(root, 'prompt-inbox-assets') })
  const elements: DraftElementRecord[] = [{ id: 'DOM1', label: '按钮', payload: null, degraded: true }]
  const service = createDraftService({
    store,
    assets,
    elements: {
      lookup: async (ids) => ids.map((id) => elements.find((e) => e.id === id) ?? { id, payload: null, degraded: true }),
    },
    maxAttachmentBytes: overrides.maxAttachmentBytes ?? 20 * 1024 * 1024,
    maxDraftBytes: overrides.maxDraftBytes ?? 50 * 1024 * 1024,
    maxRecords: overrides.maxRecords ?? 500,
  })
  return { service, store, assets, root }
}

function payload(over: Partial<DraftSavePayload> = {}): DraftSavePayload {
  return {
    text: '写一个 [DOM1] 的测试',
    originSessionId: 'sess-1',
    attachments: [],
    elements: [],
    ...over,
  }
}

test('extractElementIds 按出现顺序去重', () => {
  assert.deepEqual(extractElementIds('看 [DOM2] 和 [DOM1]，还有 [DOM2]'), ['DOM2', 'DOM1'])
})

test('extractElementIds 对无匹配返回空数组', () => {
  assert.deepEqual(extractElementIds('没有占位符'), [])
})

test('save 落一条记录并能 list/get 回来', async () => {
  const { service } = harness()
  const saved = await service.save(payload())
  assert.match(saved.record.id, /^drf_/)
  assert.equal(saved.record.active, false)
  assert.equal(service.list().length, 1)
  assert.equal(service.get(saved.record.id)?.content.text, '写一个 [DOM1] 的测试')
})

test('save 从正文提取 [DOMn] 并交由元素来源填充', async () => {
  const { service } = harness()
  const saved = await service.save(payload({ text: '看 [DOM1]' }))
  assert.equal(saved.record.content.elements.length, 1)
  assert.equal(saved.record.content.elements[0]?.id, 'DOM1')
  assert.equal(saved.record.content.elements[0]?.label, '按钮')
  assert.equal(saved.record.content.elements[0]?.degraded, true)
})

test('save 把附件字节落进旁路目录，记录里只留 sha256 引用', async () => {
  const { service, assets } = harness()
  const bytes = Buffer.from('hello-asset')
  const saved = await service.save(payload({
    attachments: [{ name: 'a.txt', mediaType: 'text/plain', size: bytes.byteLength, kind: 'file', base64: bytes.toString('base64') }],
  }))
  const [att] = saved.record.content.attachments
  assert.equal(att?.degraded, false)
  assert.ok(att?.asset)
  assert.ok(assets.has(att!.asset!.ref))
  assert.deepEqual([...assets.read(att!.asset!.ref)], [...bytes])
  // sha256 字段必须真的被读出来核对：记录里的摘要要等于附件字节的摘要，
  // 也要等于 ref 指向的那份落盘字节的摘要——否则记录无法对着资产自证。
  assert.equal(att!.asset!.sha256, createHash('sha256').update(bytes).digest('hex'),
    '记录里的 sha256 必须是附件字节的真实摘要')
  assert.equal(createHash('sha256').update(assets.read(att!.asset!.ref)).digest('hex'), att!.asset!.sha256,
    '记录里的 sha256 必须与 ref 指向的落盘字节一致')
})

test('附件超上限时降级为只存元信息，并给出警告', async () => {
  const { service } = harness({ maxAttachmentBytes: 4 })
  const saved = await service.save(payload({
    attachments: [{ name: 'big.bin', mediaType: 'application/octet-stream', size: 11, kind: 'file', base64: Buffer.from('hello-asset').toString('base64') }],
  }))
  const [att] = saved.record.content.attachments
  assert.equal(att?.degraded, true)
  assert.equal(att?.asset, undefined)
  assert.equal(att?.size, 11)
  assert.ok(saved.warnings.some((w) => w.includes('big.bin')), '降级必须回报给调用方')
})

test('附件没有 base64 时降级（不抛）', async () => {
  const { service } = harness()
  const saved = await service.save(payload({
    attachments: [{ name: 'x.bin', mediaType: 'application/octet-stream', size: 3, kind: 'file' }],
  }))
  assert.equal(saved.record.content.attachments[0]?.degraded, true)
})

test('整次超上限时抛错，且不落记录', async () => {
  const { service } = harness({ maxDraftBytes: 8 })
  await assert.rejects(
    () => service.save(payload({
      attachments: [{ name: 'a.bin', mediaType: 'application/octet-stream', size: 11, kind: 'file', base64: Buffer.from('hello-asset').toString('base64') }],
    })),
    /超过上限/,
  )
  assert.equal(service.list().length, 0)
})

test('整次超上限：抛错、不落记录，超限前的附件字节留在盘上成孤儿（由下次 GC 回收）', async () => {
  const { service, assets } = harness({ maxDraftBytes: 8 })
  const bytes = Buffer.from('hello-asset')
  const orphanRef = shardRef(createHash('sha256').update(bytes).digest('hex'))
  await assert.rejects(
    () => service.save(payload({
      attachments: [{ name: 'a.bin', mediaType: 'application/octet-stream', size: 11, kind: 'file', base64: bytes.toString('base64') }],
    })),
    /超过上限/,
  )
  assert.equal(service.list().length, 0, '超限不落记录')
  // 总字节校验在循环之后，而 assets.put 就在同一个循环里：字节已经落盘，成为没人引用的孤儿。
  // 这是既定行为（见 draft-service.ts 第 1 步注释），不是缺陷——别把校验提前来「修好」它。
  assert.equal(assets.has(orphanRef), true, '孤儿资产留在盘上是既定行为')
  // 要紧的不变量是「记录绝不指向不存在的资产」。失败后再存一条，记录侧才有东西可看。
  const okBytes = Buffer.from('ok')
  await service.save(payload({
    attachments: [{ name: 'ok.bin', mediaType: 'application/octet-stream', size: 2, kind: 'file', base64: okBytes.toString('base64') }],
  }))
  const records = service.list()
  assert.equal(records.length, 1, '失败没有挡住后续保存')
  for (const record of records) {
    for (const attachment of record.content.attachments) {
      if (attachment.asset === undefined) continue
      assert.equal(assets.has(attachment.asset.ref), true, '记录引用的资产必须真的在盘上')
    }
  }
  // 名字里的「由下次 GC 回收」也要有观测：删掉那条记录触发的回收会连孤儿一起清掉。
  assert.equal(service.remove(records[0]!.id).removed, true)
  assert.equal(assets.has(orphanRef), false, '下一次 GC 会清掉孤儿')
})

test('remove 删除记录并回收无引用资产', async () => {
  const { service, store, assets } = harness()
  const saved = await service.save(payload({
    attachments: [{ name: 'a.txt', mediaType: 'text/plain', size: 3, kind: 'file', base64: Buffer.from('abc').toString('base64') }],
  }))
  const ref = saved.record.content.attachments[0]!.asset!.ref
  const result = service.remove(saved.record.id)
  assert.equal(result.removed, true)
  assert.equal(result.reclaimed, 1)
  assert.equal(assets.has(ref), false)
  assert.equal(service.list().length, 0)
  // load() 折叠后记录就没了，上面那条 list() 断言看不到日志里剩下的 upsert 行与墓碑行；
  // 只有 remove 末尾那次 compact() 才会把它们清掉。
  assert.equal(store.recordCount(), 0, '删除后压紧：日志里不留那条 upsert 与墓碑行')
})

test('两条草稿引用同一份字节时，删一条不回收资产', async () => {
  const { service, assets } = harness()
  const base64 = Buffer.from('same-bytes').toString('base64')
  const a = await service.save(payload({ attachments: [{ name: 'a.bin', mediaType: 'application/octet-stream', size: 10, kind: 'file', base64 }] }))
  await service.save(payload({ attachments: [{ name: 'b.bin', mediaType: 'application/octet-stream', size: 10, kind: 'file', base64 }] }))
  const ref = a.record.content.attachments[0]!.asset!.ref
  const result = service.remove(a.record.id)
  assert.equal(result.reclaimed, 0, '另一条草稿仍在引用，不能删')
  assert.ok(assets.has(ref))
})

test('remove 不存在的 id 返回 removed:false', () => {
  const { service } = harness()
  assert.equal(service.remove('drf_nope').removed, false)
})

test('referencedAssetRefs 汇总所有记录引用的 ref', async () => {
  const { service } = harness()
  await service.save(payload({ attachments: [{ name: 'a.bin', mediaType: 'application/octet-stream', size: 3, kind: 'file', base64: Buffer.from('xyz').toString('base64') }] }))
  assert.equal(service.referencedAssetRefs().size, 1)
})

test('两次 save 得到不同 id', async () => {
  const { service } = harness()
  // 冻结时钟：否则「两次 id 不同」只是搭了墙钟往前走的便车，观测不到 newDraftId
  // 注释里「序号后缀保证同毫秒内唯一」这条兜底。
  const realNow = Date.now
  Date.now = () => 1_700_000_000_000
  try {
    const a = await service.save(payload())
    const b = await service.save(payload())
    assert.equal(a.record.createdAt, b.record.createdAt, '前提：时钟已冻结，两次 createdAt 相同')
    assert.notEqual(a.record.id, b.record.id, '同毫秒内 id 也必须唯一（序号兜底）')
  } finally {
    Date.now = realNow
  }
})

test('setActive 只把目标置为 true，其余清除', async () => {
  const { service } = harness()
  const a = await service.save(payload())
  const b = await service.save(payload())
  service.setActive(b.record.id)
  const byId = new Map(service.list().map((r) => [r.id, r.active]))
  assert.equal(byId.get(a.record.id), false)
  assert.equal(byId.get(b.record.id), true)
  service.setActive(null)
  assert.equal(service.list().every((r) => !r.active), true)
})

test('setActive 只写回 active 真正变化的记录', async () => {
  const { service, store } = harness()
  const a = await service.save(payload())
  await service.save(payload())
  // 第一次：只有 a 的 active 从 false 变 true，因此只该写回一行（b 本来就不是 active）。
  const linesBefore = store.recordCount()
  const activeBefore = service.list().filter((r) => r.active).length
  service.setActive(a.record.id)
  const activeAfter = service.list().filter((r) => r.active).length
  assert.equal(store.recordCount() - linesBefore, activeAfter - activeBefore,
    '追加的日志行数必须等于 active 真正变化的记录数')
  // 第二次：同一条再置一次，没有任何记录的 active 会变化，一行都不该追加。
  const linesAfterFirst = store.recordCount()
  service.setActive(a.record.id)
  assert.equal(store.recordCount(), linesAfterFirst, '无变化就不该追加日志行')
})

test('记录数超过 maxRecords 时自动压紧', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-compact-'))
  const store = createDraftStore({ logPath: join(root, 'prompt-inbox.jsonl') })
  const service = createDraftService({
    store,
    assets: createAssetStore({ root: join(root, 'assets') }),
    elements: { lookup: async (ids) => ids.map((id) => ({ id, payload: null, degraded: true })) },
    maxAttachmentBytes: 1024,
    maxDraftBytes: 1024,
    maxRecords: 2,
  })
  await service.save(payload())
  await service.save(payload())
  await service.save(payload())
  assert.equal(store.recordCount(), 3, '三条记录就是三行')
  assert.equal(service.list().length, 3, '压紧不丢记录')
  // 上面两条压紧与否都成立（三次 save 本来就是三行）。制造「行数 > 记录数」：
  // 对同一条记录再 upsert 一次（折叠后记录数不变、日志多一行），
  // 下一次 save 越过阈值时才会压紧——只有真的压紧过，行数才会回落到与记录数相等。
  store.appendUpsert(service.list()[2]!)
  assert.equal(store.recordCount(), service.list().length + 1, '前提：压紧前日志行数已经多于记录数')
  await service.save(payload())
  assert.equal(store.recordCount(), 4, '压紧后日志行数必须回落到与记录数相等')
  assert.equal(service.list().length, 4, '压紧不丢记录')
})
