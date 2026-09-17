import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bytesToBase64, flattenLine, hasRestorableAttachments, previewLine, sessionBadge, summarize } from '../../src/client/draft-record.ts'
import type { DraftRecord } from '../../src/shared/types.ts'

function record(over: Partial<DraftRecord> = {}): DraftRecord {
  return {
    id: 'drf_1', createdAt: 0, originSessionId: 'sess-a', active: false,
    content: { text: 'hello', attachments: [], elements: [] },
    ...over,
  }
}

test('bytesToBase64 与 Buffer 结果一致', () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 255])
  assert.equal(bytesToBase64(bytes), Buffer.from(bytes).toString('base64'))
})

test('bytesToBase64 处理空数组', () => {
  assert.equal(bytesToBase64(new Uint8Array([])), '')
})

test('previewLine 压平空白并截断', () => {
  assert.equal(previewLine('a\n\n  b   c'), 'a b c')
  assert.equal(previewLine('x'.repeat(80), 10), 'x'.repeat(10) + '…')
})

test('previewLine 对空文本回占位', () => {
  assert.equal(previewLine('   '), '(空草稿)')
})

test('flattenLine 只压平空白、绝不截断', () => {
  // 卡片正文走这一条：长度归 CSS 按可用宽度裁决，写死的字符数会抢在它前面切，
  // 于是"超出范围才省略号"永远看不到、展开后也补不回被砍掉的字。
  assert.equal(flattenLine('a\n\n  b   c'), 'a b c')
  const long = 'x'.repeat(500)
  assert.equal(flattenLine(long), long)
  assert.equal(flattenLine(long).includes('…'), false, 'flattenLine 不该自己加省略号')
})

test('flattenLine 对空文本回占位（否则卡片会没有任何文字）', () => {
  assert.equal(flattenLine('   '), '(空草稿)')
  assert.equal(flattenLine(''), '(空草稿)')
})

test('summarize 汇总附件与元素数量', () => {
  const r = record({
    content: {
      text: 't',
      attachments: [
        { name: 'a', mediaType: 'text/plain', size: 1, kind: 'file', degraded: false },
        { name: 'b', mediaType: 'text/plain', size: 1, kind: 'file', degraded: true },
      ],
      elements: [{ id: 'DOM1', payload: null, degraded: true }],
    },
  })
  const text = summarize(r)
  assert.match(text, /2 个附件/)
  assert.match(text, /1 个元素/)
  // 逐组点名两个数，不求和、也不折叠成单段。
  // 这里不能只断言 /1 项降级/：本记录同时有 1 个降级元素，元素段的
  // `1 项降级元素` 单独就能满足那条松断言，于是附件组的降级数（恰好 1）
  // 就没有任何断言钉住——把守卫改成 degradedAttachments > 1 也照样绿。
  assert.match(text, /1 项降级附件/)
  assert.match(text, /1 项降级元素/)
})

test('summarize 无附件无元素时不提这两项', () => {
  const text = summarize(record())
  assert.doesNotMatch(text, /附件/)
  assert.doesNotMatch(text, /元素/)
})

test('sessionBadge 对同会话返回 undefined，对异会话返回来源', () => {
  assert.equal(sessionBadge(record(), 'sess-a'), undefined)
  assert.equal(sessionBadge(record({ originLabel: '别的会话' }), 'sess-b'), '别的会话')
  assert.equal(sessionBadge(record({ originSessionId: 'sess_abcdefgh' }), 'sess-b'), 'sess_abc')
})

test('hasRestorableAttachments 只看非降级附件', () => {
  assert.equal(hasRestorableAttachments(record()), false)
  assert.equal(hasRestorableAttachments(record({
    content: { text: 't', attachments: [{ name: 'a', mediaType: 't', size: 1, kind: 'file', degraded: true }], elements: [] },
  })), false)
  assert.equal(hasRestorableAttachments(record({
    content: {
      text: 't', elements: [],
      attachments: [{ name: 'a', mediaType: 't', size: 1, kind: 'file', degraded: false, asset: { sha256: 'x', ref: 'sha256/xx/x.bin' } }],
    },
  })), true)
})

/**
 * 以上 8 条是 brief Step 1 的原文（逐字未改）；以下 6 条补的是 brief 要求里
 * 「写了、却没有任何断言能看见」的行为，
 * 逐条对应一次变异实验（把实现改坏，它们必须变红；结果见 task-7-report.md）：
 *   - 分块 base64：5 字节的输入根本跨不过 0x8000 边界，分块版与整块展开版
 *     结果完全相同，所以「右界 +1」测不出来；而「去掉分块」只有让输入大到
 *     整块展开必然抛 RangeError 时才可观测——本用例的输入就是按这条挑的
 *     （见该用例内注释），旧的 0x8000 * 2 + 3 = 65539 字节在引擎上限之内，
 *     整块展开能跑通，因此证不了「去掉分块」；
 *   - 截断边界：`>` 写成 `>=` 时，brief 的两条用例（80→10、5→60）都看不出来；
 *   - 分组计数：0 计数的组「各自不出现」只在两组**同时**为 0 时被断言过；
 *   - 降级计数：`1 项降级元素` 这一条本身就能满足 brief 的 `/1 项降级/`，
 *     所以附件组的降级数写错也照样绿——必须逐组钉住两个数；
 *   - 可恢复附件：brief 只有「降级且无 asset」与「非降级且有 asset」两种记录，
 *     于是两个判定条件各自被删掉都能蒙混过关，必须补上畸形组合。
 */
test('bytesToBase64 跨分块边界时仍与 Buffer 一致', () => {
  // 输入取 0x8000 * 4 + 3 = 131075 字节：既跨过 3 个分块边界并留下 3 字节余数，
  // 又故意**超过** V8 的实参个数上限。
  // 分块与整块展开产出的 base64 逐字节相同，所以下面的 Buffer 对拍对「有没有
  // 分块」是不敏感的；本条用例能抓「去掉分块」，靠的是整块展开
  // `String.fromCharCode(...bytes)` 在这里必然抛
  // `RangeError: Maximum call stack size exceeded`（Node v24.17.0 实测：
  // 65539 / 98304 个实参可以，131072 / 131075 个抛 RangeError）。
  // 输入若缩回 65539 字节，这条用例就退化成只对拍 base64，证不了「去掉分块」。
  const bytes = new Uint8Array(0x8000 * 4 + 3)
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 251
  assert.equal(bytesToBase64(bytes), Buffer.from(bytes).toString('base64'))
})

test('previewLine 恰好等于上限时不加省略号', () => {
  assert.equal(previewLine('abcde', 5), 'abcde')
})

test('summarize 只有附件时不提元素（0 计数的组各自不出现）', () => {
  const text = summarize(record({
    content: {
      text: 't',
      attachments: [{ name: 'a', mediaType: 'text/plain', size: 1, kind: 'file', degraded: false }],
      elements: [],
    },
  }))
  assert.equal(text, '1 个附件')
})

test('summarize 的降级数逐组点名，两个数各自钉住', () => {
  const text = summarize(record({
    content: {
      text: 't',
      attachments: [
        { name: 'a', mediaType: 'text/plain', size: 1, kind: 'file', degraded: true },
        { name: 'b', mediaType: 'text/plain', size: 1, kind: 'file', degraded: true },
        { name: 'c', mediaType: 'text/plain', size: 1, kind: 'file', degraded: false },
      ],
      elements: [
        { id: 'DOM1', payload: null, degraded: true },
        { id: 'DOM2', payload: null, degraded: false },
      ],
    },
  }))
  assert.equal(text, '3 个附件 · 2 个元素 · 2 项降级附件 · 1 项降级元素')
})

test('summarize 没有附件时也点名降级元素', () => {
  const text = summarize(record({
    content: { text: 't', attachments: [], elements: [{ id: 'DOM1', payload: null, degraded: true }] },
  }))
  assert.equal(text, '1 个元素 · 1 项降级元素')
})

test('hasRestorableAttachments 要求「非降级」与「带 asset」同时成立', () => {
  const asset = { sha256: 'x', ref: 'sha256/xx/x.bin' }
  // 降级附件就算带着 asset 引用也不算可恢复：字节在保存时就已经丢了。
  assert.equal(hasRestorableAttachments(record({
    content: {
      text: 't', elements: [],
      attachments: [{ name: 'a', mediaType: 't', size: 1, kind: 'file', degraded: true, asset }],
    },
  })), false)
  // 非降级但没有 asset 的附件没有可取字节的引用，同样不算可恢复。
  assert.equal(hasRestorableAttachments(record({
    content: {
      text: 't', elements: [],
      attachments: [{ name: 'a', mediaType: 't', size: 1, kind: 'file', degraded: false }],
    },
  })), false)
})
