/**
 * composer 适配层的用例。
 *
 * 这里刻意**不**碰 React、也不碰 DOM：适配层是纯函数 + `fetch`/`File` 两个
 * 全局，而 Node 24 同时提供这两个全局，所以「保存 → 回弹」的整条字节往返
 * 能在单测里跑真身（而不是替身）。
 *
 * 回弹顺序（先附件后正文）是本模块唯一的硬约束，用例用**调用序列**钉住它，
 * 而不是靠读代码。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clearComposer, hasComposerContent, resolveComposer, restoreDraft, snapshotDraft } from '../../src/client/composer-bridge.ts'
import type { ClientCtx, ComposerAttachmentLike, ComposerFace, InputActionsLike } from '../../src/client/services.ts'
import type { DraftRecord } from '../../src/shared/types.ts'

/** 只带 `get` 的假 ctx：适配层只从它取 conversation。 */
function ctxWith(conversation: unknown): ClientCtx {
  return { get: (name: string) => (name === 'conversation' ? conversation : undefined) } as unknown as ClientCtx
}

/** 记录调用顺序的假 ComposerFace。 */
interface FakeComposer {
  readonly face: ComposerFace
  /** 每次 createDrafts 收到的文件，按调用顺序。 */
  readonly created: { sessionId: string; files: readonly Blob[] }[]
  /** resolveDraftAttachments 每次收到的 id 列表。 */
  readonly resolved: (readonly string[])[]
  /** releaseDraftAttachments 每次收到的附件（按对象，不是按 id 重造的）。 */
  readonly released: (readonly { id: string }[])[]
  /** 全量调用序列（含 addAttachments / setDraft），用于钉「附件先于正文」。 */
  readonly order: string[]
}

function fakeComposer(
  attachments: readonly ComposerAttachmentLike[] = [],
  order: string[] = [],
  newIds: readonly string[] = ['att-new'],
): FakeComposer {
  const created: { sessionId: string; files: readonly Blob[] }[] = []
  const resolved: (readonly string[])[] = []
  const released: (readonly { id: string }[])[] = []
  return {
    created,
    resolved,
    released,
    order,
    face: {
      resolveDraftAttachments: (ids) => {
        resolved.push(ids)
        return attachments
      },
      createDrafts: (sessionId, files) => {
        order.push('createDrafts')
        created.push({ sessionId, files })
        return newIds.map((id) => ({ id }))
      },
      releaseDraftAttachments: (drafts) => {
        order.push('releaseDraftAttachments')
        released.push(drafts)
      },
    },
  }
}

/** 方法齐备的假 conversation 面：三个包内面方法都在（校验表要逐个覆盖）。 */
function fullFace(): {
  resolveDraftAttachments: (ids: readonly string[]) => readonly ComposerAttachmentLike[]
  createDrafts: (sessionId: string, files: readonly Blob[]) => readonly { id: string }[]
  releaseDraftAttachments: (attachments: readonly { id: string }[]) => void
} {
  return {
    resolveDraftAttachments: () => [],
    createDrafts: () => [],
    releaseDraftAttachments: () => {},
  }
}

/** fetch 替身：记录 URL，按 URL 决定成败。 */
function stubFetch(answer: (url: string) => { ok: boolean; status?: number; bytes?: Uint8Array }) {
  const original = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = ((input: unknown) => {
    const url = String(input)
    urls.push(url)
    const result = answer(url)
    return Promise.resolve({
      ok: result.ok,
      status: result.status ?? (result.ok ? 200 : 500),
      arrayBuffer: () => Promise.resolve((result.bytes ?? new Uint8Array()).slice().buffer),
    })
  }) as unknown as typeof fetch
  return { urls, restore: () => { globalThis.fetch = original } }
}

/** console.error 替身：`logError` 会往这里写，用来分辨「按设计跳过」与「抛错后被 catch」。 */
function stubConsoleError() {
  const original = console.error
  const messages: string[] = []
  console.error = (...args: unknown[]) => { messages.push(args.map(String).join(' ')) }
  return { messages, restore: () => { console.error = original } }
}

/** 一条带 asset 引用的记录（host 保存后的形状）。 */
function recordWith(
  attachments: DraftRecord['content']['attachments'],
  text = '正文',
): DraftRecord {
  return {
    id: 'drf_1', createdAt: 0, originSessionId: 'sess-a', active: false,
    content: { text, attachments, elements: [] },
  }
}

const REF = 'sha256/ab/' + 'f'.repeat(64) + '.bin'
const REF_URL = '/dsh-prompt-inbox/asset?ref=' + encodeURIComponent(REF)

// ---------------------------------------------------------------- resolveComposer

test('resolveComposer 在 conversation 服务缺失时抛出可定位错误', () => {
  assert.throws(
    () => resolveComposer(ctxWith(undefined)),
    { message: 'conversation 服务不可用：无法保存/回弹附件' },
  )
})

test('resolveComposer 逐个校验包内面方法，错误信息点名缺失的方法', () => {
  // 三个方法各自被删掉一次：只校验其中一部分的实现会在另外几条上变绿。
  const face = fullFace()
  assert.throws(
    () => resolveComposer(ctxWith({ createDrafts: face.createDrafts, releaseDraftAttachments: face.releaseDraftAttachments })),
    { message: 'conversation 服务的 resolveDraftAttachments 已不可用（harness 升级可能改了包内面），请升级本插件' },
  )
  assert.throws(
    () => resolveComposer(ctxWith({ resolveDraftAttachments: face.resolveDraftAttachments, releaseDraftAttachments: face.releaseDraftAttachments })),
    { message: 'conversation 服务的 createDrafts 已不可用（harness 升级可能改了包内面），请升级本插件' },
  )
  assert.throws(
    () => resolveComposer(ctxWith({ resolveDraftAttachments: face.resolveDraftAttachments, createDrafts: face.createDrafts })),
    { message: 'conversation 服务的 releaseDraftAttachments 已不可用（harness 升级可能改了包内面），请升级本插件' },
  )
  // 方法存在但不是函数（被改成属性）同样要拦下
  assert.throws(
    () => resolveComposer(ctxWith({ resolveDraftAttachments: face.resolveDraftAttachments, createDrafts: face.createDrafts, releaseDraftAttachments: 'nope' })),
    /releaseDraftAttachments 已不可用/,
  )
})

test('resolveComposer 方法齐备时返回服务本身（下游调到的是真方法）', () => {
  const conversation = fullFace()
  assert.equal(resolveComposer(ctxWith(conversation)), conversation)
})

// ---------------------------------------------------------------- snapshotDraft

test('snapshotDraft 把正文、会话 id 与附件字节（base64）装进载荷', async () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 255])
  const file = new File([bytes], 'note.txt', { type: 'text/plain' })
  const composer = fakeComposer([{ kind: 'file', id: 'a1', file }])

  const payload = await snapshotDraft(composer.face, 'sess-now', { draft: '你好', attachmentIds: ['a1'] })

  assert.deepEqual(payload, {
    text: '你好',
    // 是**当前会话**，不是来源会话：保存发生在哪就记在哪
    originSessionId: 'sess-now',
    attachments: [{
      name: 'note.txt',
      mediaType: 'text/plain',
      size: 5,
      kind: 'file',
      base64: Buffer.from(bytes).toString('base64'),
    }],
    // 元素由 host 从正文里提，client 不解析占位符
    elements: [],
  })
  // 解析用的正是输入框给的 id 列表
  assert.deepEqual(composer.resolved, [['a1']])
})

test('snapshotDraft 对空 MIME 回退到 application/octet-stream，并保留附件 kind', async () => {
  const file = new File([new Uint8Array([9])], 'blob.bin')
  const composer = fakeComposer([{ kind: 'image', id: 'i1', file }])

  const payload = await snapshotDraft(composer.face, 's', { draft: 'x', attachmentIds: ['i1'] })

  assert.equal(payload.attachments.length, 1)
  assert.equal(payload.attachments[0]?.mediaType, 'application/octet-stream')
  assert.equal(payload.attachments[0]?.kind, 'image')
  assert.equal(payload.attachments[0]?.name, 'blob.bin')
})

test('snapshotDraft 没有附件时给出空数组，不臆造附件', async () => {
  const composer = fakeComposer()
  const payload = await snapshotDraft(composer.face, 's', { draft: '只有文字', attachmentIds: [] })
  assert.deepEqual(payload.attachments, [])
  assert.deepEqual(payload.text, '只有文字')
})

// ---------------------------------------------------------------- restoreDraft

test('restoreDraft 先建附件、再加附件、最后写正文（顺序不可倒）', async () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 255])
  // 先按保存路径造出真实载荷，再把它当成 host 存下的记录回弹：往返比的是字节
  const saved = await snapshotDraft(
    fakeComposer([{ kind: 'image', id: 'i1', file: new File([bytes], '图.png', { type: 'image/png' }) }]).face,
    'sess-a',
    { draft: '正文', attachmentIds: ['i1'] },
  )
  assert.equal(saved.attachments[0]?.base64, Buffer.from(bytes).toString('base64'))

  const record = recordWith([{
    name: '图.png', mediaType: 'image/png', size: bytes.length, kind: 'image',
    degraded: false, asset: { sha256: 'ff', ref: REF },
  }])

  const order: string[] = []
  const composer = fakeComposer([], order)
  const drafts: string[] = []
  const addedIds: string[] = []
  const actions: InputActionsLike = {
    setDraft: (text) => { order.push('setDraft'); drafts.push(text) },
    addAttachments: (ids) => { order.push('addAttachments'); addedIds.push(...ids); return true },
  }

  const stub = stubFetch(() => ({ ok: true, bytes }))
  try {
    const result = await restoreDraft(composer.face, 'sess-a', record, actions, { [REF]: REF_URL })

    // 顺序断言：addAttachments 在 busy 阶段会被拒、setDraft 是整体替换，
    // 所以三者必须是 建 → 加 → 写；任何重排都会让这条变红。
    assert.deepEqual(order, ['createDrafts', 'addAttachments', 'setDraft'])
    assert.deepEqual(drafts, ['正文'])
    // 加进去的正是 createDrafts 发号的 id
    assert.deepEqual(addedIds, ['att-new'])
    // 成功路径**不能**归还：归还的是「没进的去输入框」的那批，成功的被归还等于用户白等
    assert.deepEqual(composer.released, [])
    // 取字节走的是 host 给的完整路径（再包一层 assetUrl 会把 ref 编码两次，host 直接拒）
    assert.deepEqual(stub.urls, [REF_URL])
    // 字节与 MIME 原样回到浏览器 File 上
    const created = composer.created[0]
    assert.equal(created?.sessionId, 'sess-a')
    assert.equal(created?.files.length, 1)
    const rebuilt = created?.files[0] as File
    assert.equal(rebuilt.name, '图.png')
    assert.equal(rebuilt.type, 'image/png')
    assert.deepEqual(new Uint8Array(await rebuilt.arrayBuffer()), bytes)
    assert.deepEqual(result, { restored: 1, missing: 0 })
  } finally {
    stub.restore()
  }
})

test('restoreDraft 把取字节失败的附件降级为跳过并计数，正文照写', async () => {
  const record = recordWith([{
    name: 'a.bin', mediaType: 'application/octet-stream', size: 3, kind: 'file',
    degraded: false, asset: { sha256: 'ff', ref: REF },
  }])
  const order: string[] = []
  const composer = fakeComposer([], order)
  const drafts: string[] = []

  const stub = stubFetch(() => ({ ok: false, status: 500 }))
  try {
    const result = await restoreDraft(composer.face, 's', record, {
      setDraft: (text) => { order.push('setDraft'); drafts.push(text) },
      addAttachments: () => { order.push('addAttachments'); return true },
    }, { [REF]: REF_URL })

    assert.deepEqual(result, { restored: 0, missing: 1 })
    // 一个附件都没拿到：不去发号、也不去加，正文仍然回弹
    assert.deepEqual(order, ['setDraft'])
    assert.deepEqual(drafts, ['正文'])
  } finally {
    stub.restore()
  }
})

test('restoreDraft 跳过降级附件并把它计进 missing（也不为它取字节）', async () => {
  const record = recordWith([
    { name: 'gone.bin', mediaType: 'text/plain', size: 1, kind: 'file', degraded: true },
    { name: 'ok.bin', mediaType: 'text/plain', size: 3, kind: 'file', degraded: false, asset: { sha256: 'ff', ref: REF } },
  ])
  const order: string[] = []
  const composer = fakeComposer([], order)

  const stub = stubFetch(() => ({ ok: true, bytes: new Uint8Array([7, 7, 7]) }))
  try {
    const result = await restoreDraft(composer.face, 's', record, {
      setDraft: () => { order.push('setDraft') },
      addAttachments: () => { order.push('addAttachments'); return true },
    }, { [REF]: REF_URL })

    // 只有非降级的那条被取字节：降级项根本没有 asset 可读
    assert.deepEqual(stub.urls, [REF_URL])
    assert.deepEqual(result, { restored: 1, missing: 1 })
  } finally {
    stub.restore()
  }
})

test('restoreDraft 把 degraded 为 false 但没有 asset 的附件跳过并计进 missing（不读 asset.ref）', async () => {
  // 这条专门钉跳过判定的第二个分支：只查 degraded 的实现会在这里走进 try，
  // 读 `asset.ref` 抛 TypeError，被 catch 吞掉——结果同样是 missing=1，
  // 所以光比对计数分辨不出来，必须同时断言没有走过 logError。
  const record = recordWith([
    { name: 'no-asset.bin', mediaType: 'text/plain', size: 2, kind: 'file', degraded: false },
    { name: 'ok.bin', mediaType: 'text/plain', size: 3, kind: 'file', degraded: false, asset: { sha256: 'ff', ref: REF } },
  ])
  const order: string[] = []
  const composer = fakeComposer([], order)
  const stub = stubFetch(() => ({ ok: true, bytes: new Uint8Array([7, 7, 7]) }))
  const errors = stubConsoleError()
  try {
    const result = await restoreDraft(composer.face, 's', record, {
      setDraft: () => { order.push('setDraft') },
      addAttachments: () => { order.push('addAttachments'); return true },
    }, { [REF]: REF_URL })

    assert.deepEqual(result, { restored: 1, missing: 1 })
    // 没有 asset 的那条既不取字节（urls 里只有好那条），也没有炸出错误日志
    assert.deepEqual(stub.urls, [REF_URL])
    assert.deepEqual(errors.messages, [])
    // 它前面那条不影响后面的正文回弹
    assert.deepEqual(order, ['createDrafts', 'addAttachments', 'setDraft'])
  } finally {
    stub.restore()
    errors.restore()
  }
})

test('restoreDraft 在 assetUrls 缺该 ref 时回退到 assetUrl 拼的路径', async () => {
  const record = recordWith([{
    name: 'a.bin', mediaType: 'text/plain', size: 1, kind: 'file',
    degraded: false, asset: { sha256: 'ff', ref: REF },
  }])
  const composer = fakeComposer()
  const stub = stubFetch(() => ({ ok: true, bytes: new Uint8Array([1]) }))
  try {
    const result = await restoreDraft(composer.face, 's', record, {
      setDraft: () => {}, addAttachments: () => true,
    }, {})
    assert.deepEqual(stub.urls, ['/dsh-prompt-inbox/asset?ref=' + encodeURIComponent(REF)])
    assert.deepEqual(result, { restored: 1, missing: 0 })
  } finally {
    stub.restore()
  }
})

test('restoreDraft 在附件被输入框拒收时归还已创建的附件并抛错，且不写正文（不做半截回弹）', async () => {
  const record = recordWith([{
    name: 'a.bin', mediaType: 'text/plain', size: 1, kind: 'file',
    degraded: false, asset: { sha256: 'ff', ref: REF },
  }])
  const order: string[] = []
  const composer = fakeComposer([], order)
  const stub = stubFetch(() => ({ ok: true, bytes: new Uint8Array([1]) }))
  try {
    await assert.rejects(
      () => restoreDraft(composer.face, 's', record, {
        setDraft: () => { order.push('setDraft') },
        addAttachments: () => { order.push('addAttachments'); return false },
      }, { [REF]: REF_URL }),
      /输入框正忙/,
    )
    // 三条一起钉：附件没进去就不写正文（否则是「有正文、没附件」的假成功）；
    // 而 createDrafts 已经登记了草稿对象、起了后台上传，先归还得掉再抛错。
    assert.deepEqual(order, ['createDrafts', 'addAttachments', 'releaseDraftAttachments'])
    // 归还的是 createDrafts 刚发出来那批（按对象比对：还 files、还空数组都算错）
    assert.deepEqual(composer.released, [[{ id: 'att-new' }]])
    assert.equal(composer.created[0]?.files.length, 1)
  } finally {
    stub.restore()
  }
})

test('restoreDraft 在 inputActions 缺方法时抛出可定位错误', async () => {
  const composer = fakeComposer()
  // 没有任何附件时只差 setDraft：错误点名它
  await assert.rejects(
    () => restoreDraft(composer.face, 's', recordWith([]), {}, {}),
    /inputActions.setDraft 不可用/,
  )
  // 有附件可取时再缺 addAttachments：错误点名后者（不是笼统的 undefined is not a function）
  const stub = stubFetch(() => ({ ok: true, bytes: new Uint8Array([1]) }))
  try {
    await assert.rejects(
      () => restoreDraft(composer.face, 's', recordWith([{
        name: 'a.bin', mediaType: 'text/plain', size: 1, kind: 'file',
        degraded: false, asset: { sha256: 'ff', ref: REF },
      }]), { setDraft: () => {} }, { [REF]: REF_URL }),
      /inputActions.addAttachments 不可用/,
    )
  } finally {
    stub.restore()
  }
})

// ------------------------------------------------- 空输入框判定（「有内容才出现」）

/**
 * 这里只钉住**判定本身**的真值表：组件是否拿这个判定去 `return null`，Node 里
 * 无法观测（组件模块 import react，而仓库只装了 `@types/react`），那一步由 Task 10
 * 端到端验证。用例名因此只说判定，不说「按钮出现/消失」。
 */
test('hasComposerContent：空白正文且无附件才算空，其余都算有内容', () => {
  assert.equal(hasComposerContent('', []), false)
  // 只有空白的正文不算内容（否则输入框里敲个空格就会多出一个保存按钮）
  assert.equal(hasComposerContent('   \n\t ', []), false)
  assert.equal(hasComposerContent('', ['att-1']), true)
  assert.equal(hasComposerContent('   ', ['att-1']), true)
  assert.equal(hasComposerContent('字', []), true)
})

// ------------------------------------------------- 保存成功后的清空（清空必须彻底）

/**
 * 清空必须与上面的判定**同源**：`hasComposerContent` 认「正文或附件」，所以清空就得
 * 两样都清——只清正文会留下一个仍算「有内容」的输入框，保存按钮继续挂在工具行上。
 *
 * 这里同样只钉 `clearComposer` 这个纯函数的调用序列与降级行为（组件是否在保存成功后
 * 调它、清完输入框在页面上长什么样，归浏览器验收）。
 */

/** 记录调用顺序的假输入动作面；`drop` 用来模拟 harness 没提供某个成员。 */
function fakeActions(drop?: 'setDraft' | 'removeAttachment') {
  const order: string[] = []
  const drafts: string[] = []
  const removed: string[] = []
  const actions: InputActionsLike = {}
  if (drop !== 'setDraft') {
    actions.setDraft = (text) => { order.push('setDraft'); drafts.push(text) }
  }
  if (drop !== 'removeAttachment') {
    actions.removeAttachment = (id) => { order.push('removeAttachment'); removed.push(id) }
  }
  return { actions, order, drafts, removed }
}

test('clearComposer：正文清成空串，附件按观测到的顺序逐个摘掉（两样都清才算清空）', () => {
  const f = fakeActions()
  clearComposer(f.actions, ['att-1', 'att-2'])

  // 正文清成**空串**（不是空白，也不是 undefined）
  assert.deepEqual(f.drafts, [''])
  // 每个附件各一次、按输入框给的顺序（id 就是唯一凭据，顺序无关但必须一个不漏）
  assert.deepEqual(f.removed, ['att-1', 'att-2'])
  assert.deepEqual(f.order, ['setDraft', 'removeAttachment', 'removeAttachment'])
})

test('clearComposer：输入框本来就没有附件时不去调 removeAttachment', () => {
  const f = fakeActions()
  clearComposer(f.actions, [])

  assert.deepEqual(f.drafts, [''])
  assert.deepEqual(f.order, ['setDraft'])
})

test('clearComposer：setDraft 缺失时整体不动（半清空比不清空更糟），并留一条 ERROR', () => {
  // 正文没了、附件还在 = 用户既丢了内容又没得到「已清空」；此时什么都不做，
  // 至少界面上那半条草稿还在，用户看得见。日志是这条降级唯一的出口。
  const f = fakeActions('setDraft')
  const logged = stubConsoleError()
  try {
    clearComposer(f.actions, ['att-1'])

    assert.deepEqual(f.order, [])
    assert.deepEqual(f.removed, [])
    assert.equal(logged.messages.length, 1)
    assert.match(logged.messages[0], /setDraft 不可用/)
  } finally {
    logged.restore()
  }
})

test('clearComposer：removeAttachment 缺失时正文照清、附件留下，并留一条带数量的 ERROR', () => {
  // 这是 harness 降级而不是本插件的错误：能清多少清多少，但绝不静默——
  // 「正文清了、附件还在」在界面上表现为保存按钮继续挂着，日志必须能解释它。
  const f = fakeActions('removeAttachment')
  const logged = stubConsoleError()
  try {
    clearComposer(f.actions, ['att-1', 'att-2'])

    assert.deepEqual(f.drafts, [''])
    assert.deepEqual(f.order, ['setDraft'])
    assert.equal(logged.messages.length, 1)
    assert.match(logged.messages[0], /removeAttachment 不可用/)
    assert.match(logged.messages[0], /2 个附件/)
  } finally {
    logged.restore()
  }
})

test('clearComposer：空动作面（槽位没给 inputActions）不抛错，只留痕', () => {
  // 保存按钮在 `props.inputActions` 缺失时传的是 `{}`，清空这一步不能因此把
  // 一次**已经成功**的保存炸成异常
  const logged = stubConsoleError()
  try {
    assert.doesNotThrow(() => { clearComposer({}, []) })
    assert.equal(logged.messages.length, 1)
    assert.match(logged.messages[0], /setDraft 不可用/)
  } finally {
    logged.restore()
  }
})
