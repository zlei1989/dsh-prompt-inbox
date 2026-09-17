/**
 * 回弹动作（`performRestore`）与「回弹前先确认覆盖」判定的用例。
 *
 * 这是本任务里唯一能在 Node 里跑真身的一段逻辑：它只依赖 `ctx.get('conversation')`
 * （假 ctx 直接给）、全局 `fetch`（替身）与 `File`，不碰 React、不碰 DOM。两个界面
 * 组件（`DraftView` / `DraftStrip`）加载不了——仓库只装了 `@types/react`，没有 react
 * 运行时——所以本文件**不声称任何组件行为**：可见性、按钮点击、确认面板是否渲染，
 * 全部归 Task 10 的浏览器验收。这里只钉可观测的四条：
 *
 *   1. 记录必须重新从 host 取（列表里那一行可能是旧快照），置 active 用它的 id；
 *   2. `missing` 必须原样返回给调用方（算出来就得交出去，不能丢掉）；
 *   3. **回弹失败不得置 active**（两条不同的失败路径各钉一次）；
 *   4. `assetUrls` 必须原样透传给 `restoreDraft`（host 给的路径优先，缺项才回退拼）；
 *   5. **置 active 失败不得被吞**（业务失败与传输失败各钉一次）：正文已经进了输入框，
 *      所以回 `ok:true` + 非空 `warning` + 一条带业务上下文的 ERROR 日志，而不是失败；
 *   6. 提示拼接（`restoreNotice`）里成功文案与 `warning` **同时在**，谁都不吞谁；
 *   7. **只有成功回弹才记下「内容在输入框里」**：记下之后，输入框变空时
 *      `active-draft` 的协调器才会发出那一次复位请求（清 active + 清元素激活集）；
 *      两条失败路径各钉一次，置 active 失败（只回 warning）的那条也必须记。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { performRestore, restoreNotice, shouldConfirmOverwrite } from '../../src/client/restore-action.ts'
import type { RestoreOutcome } from '../../src/client/restore-action.ts'
import { noteComposerChange, resetActiveDraftForTest } from '../../src/client/active-draft.ts'
import type { ClientCtx, ComposerFace, InputActionsLike } from '../../src/client/services.ts'
import type { DraftAttachmentRecord, DraftRecord } from '../../src/shared/types.ts'

// ---------------------------------------------------------------- 替身与夹具

/** 只带 `get` 的假 ctx：回弹动作只从它取 conversation。 */
function ctxWith(conversation: unknown): ClientCtx {
  return { get: (name: string) => (name === 'conversation' ? conversation : undefined) } as unknown as ClientCtx
}

/** 一条带 asset 引用的附件（host 保存后的形状）。 */
function attachment(): DraftAttachmentRecord {
  return {
    name: '图.png', mediaType: 'image/png', size: 3, kind: 'image',
    degraded: false, asset: { sha256: 'ff', ref: REF },
  }
}

/** 一条只存了元信息的降级附件：回弹时拿不回字节。 */
function degradedAttachment(): DraftAttachmentRecord {
  return { name: 'gone.bin', mediaType: 'text/plain', size: 1, kind: 'file', degraded: true }
}

function recordWith(
  attachments: DraftAttachmentRecord[],
  text: string,
  id = 'drf_1',
): DraftRecord {
  return { id, createdAt: 0, originSessionId: 'sess-a', active: false, content: { text, attachments, elements: [] } }
}

/** 回弹用的假 composer + 输入动作面，两者共用同一条调用序列。 */
interface Fake {
  readonly face: ComposerFace
  readonly actions: InputActionsLike
  /** 全量调用序列（createDrafts / addAttachments / releaseDraftAttachments / setDraft）。 */
  readonly order: string[]
  /** `setDraft` 收到的正文，按调用顺序。 */
  readonly drafts: string[]
  /** `addAttachments` 真正收下的 id（被拒时不记）。 */
  readonly added: string[]
  /** `releaseDraftAttachments` 收到的批次。 */
  readonly released: (readonly { id: string }[])[]
  /** `createDrafts` 收到的会话 id 与文件数。 */
  readonly created: { sessionId: string; files: number }[]
}

/**
 * @param refuse - true 时 `addAttachments` 返回 false（模拟输入框正忙拒收）。
 */
function fake(refuse = false): Fake {
  const order: string[] = []
  const drafts: string[] = []
  const added: string[] = []
  const released: (readonly { id: string }[])[] = []
  const created: { sessionId: string; files: number }[] = []
  return {
    order, drafts, added, released, created,
    face: {
      resolveDraftAttachments: () => [],
      createDrafts: (sessionId, files) => {
        order.push('createDrafts')
        created.push({ sessionId, files: files.length })
        return [{ id: 'att-new' }]
      },
      releaseDraftAttachments: (batch) => {
        order.push('releaseDraftAttachments')
        released.push(batch)
      },
    },
    actions: {
      setDraft: (text) => { order.push('setDraft'); drafts.push(text) },
      addAttachments: (ids) => {
        order.push('addAttachments')
        if (refuse) return false
        added.push(...ids)
        return true
      },
    },
  }
}

/** 假 host：`/invoke` 的信封由 `answer` 决定，`/asset` 的字节由 `assetAnswer` 决定。 */
interface HostStub {
  /** `/invoke` 上被调用的方法名，按调用顺序。 */
  readonly methods: string[]
  /** 每次 `/invoke` 的完整请求体（信封里的 method 与 params）。 */
  readonly bodies: { method: string; params: Record<string, unknown> }[]
  /** `/asset` 上被请求的 URL，按调用顺序。 */
  readonly assetUrls: string[]
  restore(): void
}

/**
 * @param answer - 按方法名给出 `/invoke` 信封；返回 undefined 表示 HTTP 500。
 * @param assetAnswer - 按 URL 给出字节；返回 undefined 表示 HTTP 500。
 */
function stubHost(
  answer: (method: string, params: Record<string, unknown>) => unknown,
  assetAnswer: (url: string) => Uint8Array | undefined = () => new Uint8Array([1, 2, 3]),
): HostStub {
  const original = globalThis.fetch
  const methods: string[] = []
  const bodies: { method: string; params: Record<string, unknown> }[] = []
  const assetUrls: string[] = []
  globalThis.fetch = ((input: unknown, init?: { body?: string }) => {
    const url = String(input)
    if (url.includes('/asset')) {
      assetUrls.push(url)
      const bytes = assetAnswer(url)
      return Promise.resolve({
        ok: bytes !== undefined,
        status: bytes === undefined ? 500 : 200,
        arrayBuffer: () => Promise.resolve((bytes ?? new Uint8Array()).slice().buffer),
      })
    }
    const body = JSON.parse(String(init?.body ?? '{}')) as { method: string; params: Record<string, unknown> }
    methods.push(body.method)
    bodies.push(body)
    const envelope = answer(body.method, body.params)
    return Promise.resolve({
      ok: envelope !== undefined,
      status: envelope === undefined ? 500 : 200,
      json: () => Promise.resolve(envelope),
    })
  }) as unknown as typeof fetch
  return { methods, bodies, assetUrls, restore: () => { globalThis.fetch = original } }
}

/**
 * 临时接管 `console.error`（`logError` 的唯一落点），把「有没有留痕」变成可断言的。
 *
 * 只替换一个函数、用完立刻还回去：用例之间不残留全局状态（同 `stubHost` 的形状）。
 */
function captureErrors(): { lines: string[]; restore(): void } {
  const original = console.error
  const lines: string[] = []
  console.error = ((...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(' '))
  }) as typeof console.error
  return { lines, restore: () => { console.error = original } }
}

const REF = 'sha256/ab/' + 'f'.repeat(64) + '.bin'
/** host 在 `assetUrls` 里给的「完整请求路径」——刻意与兜底拼出来的不同，好分辨走了哪条。 */
const HOST_URL = '/dsh-prompt-inbox/asset?ref=host-token'
/** `assetUrl(ref)` 的兜底结果（assetUrls 缺项时才会用到）。 */
const FALLBACK_URL = '/dsh-prompt-inbox/asset?ref=' + encodeURIComponent(REF)

// ---------------------------------------------------------------- performRestore

test('performRestore 重新从 host 取记录，把附件与正文写回输入框，成功后置 active', async () => {
  const fetched = recordWith([attachment()], 'host 上的新正文')
  // 列表里那一行是旧快照：正文与 host 上的不一致，用它回弹就会把旧文本写回输入框
  const stale = recordWith([attachment()], '列表里的旧正文')
  const f = fake()
  const stub = stubHost((method) => {
    if (method === 'draft-get') return { ok: true, record: fetched, assetUrls: { [REF]: HOST_URL } }
    if (method === 'draft-set-active') return { ok: true }
    return { ok: false, error: '未预期的方法：' + method }
  })
  try {
    const outcome = await performRestore(ctxWith(f.face), 'sess-now', stale, f.actions)

    assert.deepEqual(outcome, { ok: true, missing: 0 })
    assert.deepEqual(stub.methods, ['draft-get', 'draft-set-active'])
    assert.deepEqual(stub.bodies, [
      { method: 'draft-get', params: { id: 'drf_1' } },
      { method: 'draft-set-active', params: { id: 'drf_1' } },
    ])
    // 取字节走 host 给的那条路径（若 performRestore 把 assetUrls 丢掉，这里会变成兜底 URL）
    assert.deepEqual(stub.assetUrls, [HOST_URL])
    assert.deepEqual(f.order, ['createDrafts', 'addAttachments', 'setDraft'])
    // 写回的是 host 刚给的正文，不是列表里的旧快照
    assert.deepEqual(f.drafts, ['host 上的新正文'])
    assert.deepEqual(f.added, ['att-new'])
    // 回弹目标是**当前会话**，不是草稿的来源会话（sess-a）
    assert.deepEqual(f.created, [{ sessionId: 'sess-now', files: 1 }])
    // 成功路径不归还：归还的是「没进输入框」的那批
    assert.deepEqual(f.released, [])
  } finally {
    stub.restore()
  }
})

test('performRestore 在 host 没给 assetUrls 时回退到 assetUrl 拼的路径', async () => {
  const fetched = recordWith([attachment()], '正文')
  const f = fake()
  const stub = stubHost((method) => {
    if (method === 'draft-get') return { ok: true, record: fetched }
    return { ok: true }
  })
  try {
    const outcome = await performRestore(ctxWith(f.face), 'sess-now', fetched, f.actions)

    assert.deepEqual(outcome, { ok: true, missing: 0 })
    assert.deepEqual(stub.assetUrls, [FALLBACK_URL])
  } finally {
    stub.restore()
  }
})

test('performRestore 把未能恢复的附件数交给调用方（降级项也计数），成功仍置 active', async () => {
  const fetched = recordWith([degradedAttachment(), attachment()], '正文')
  const f = fake()
  const stub = stubHost((method) => {
    if (method === 'draft-get') return { ok: true, record: fetched, assetUrls: { [REF]: HOST_URL } }
    return { ok: true }
  })
  try {
    const outcome = await performRestore(ctxWith(f.face), 'sess-now', fetched, f.actions)

    // 计数必须交出去：界面上的「N 个附件未能恢复」就是它
    assert.deepEqual(outcome, { ok: true, missing: 1 })
    // 降级项没有 asset，不为它取字节
    assert.deepEqual(stub.assetUrls, [HOST_URL])
    // 部分附件拿不回来不算失败：正文照写、仍然置 active
    assert.deepEqual(stub.methods, ['draft-get', 'draft-set-active'])
    assert.deepEqual(f.drafts, ['正文'])
  } finally {
    stub.restore()
  }
})

test('performRestore 在 draft-get 失败时原样报错，不碰输入框、也不置 active', async () => {
  const f = fake()
  const stub = stubHost(() => ({ ok: false, error: '草稿不存在' }))
  try {
    const outcome = await performRestore(ctxWith(f.face), 'sess-now', recordWith([], '正文'), f.actions)

    assert.deepEqual(outcome, { ok: false, error: '草稿不存在', missing: 0 })
    assert.deepEqual(stub.methods, ['draft-get'])
    assert.deepEqual(f.order, [])
    assert.deepEqual(stub.assetUrls, [])
  } finally {
    stub.restore()
  }
})

test('performRestore 在 draft-get 只回 ok 却不带记录时报「读取草稿失败」，不置 active', async () => {
  // 这条钉住 got.record === undefined 那一半：只查 got.ok 的实现会带着 undefined 往下走，
  // 在 restoreDraft 里炸成 TypeError 文案，且仍然不会置 active——错误的**文案**是唯一区分点
  const f = fake()
  const stub = stubHost(() => ({ ok: true, assetUrls: {} }))
  try {
    const outcome = await performRestore(ctxWith(f.face), 'sess-now', recordWith([], '正文'), f.actions)

    assert.deepEqual(outcome, { ok: false, error: '读取草稿失败', missing: 0 })
    assert.deepEqual(stub.methods, ['draft-get'])
    assert.deepEqual(f.order, [])
  } finally {
    stub.restore()
  }
})

test('performRestore 在 draft-get 这一步传输失败（HTTP 500）时也不 reject，而是回 ok:false', async () => {
  // 这条钉住「本函数不 reject」：draft-get 若留在 try 之外，hostCall 抛出的 HTTP 错误会
  // 变成 rejection——两个入口的调用链都没有 catch，界面一片安静（控制台只多一条未处理
  // 的 rejection）。用例同时就是那个可观测点：rejection 会让 await 直接抛，测试失败。
  const f = fake()
  const stub = stubHost(() => undefined)
  try {
    const outcome = await performRestore(ctxWith(f.face), 'sess-now', recordWith([], '正文'), f.actions)

    assert.deepEqual(outcome, { ok: false, error: 'HTTP 500', missing: 0 })
    assert.deepEqual(stub.methods, ['draft-get'])
    assert.deepEqual(f.order, [])
  } finally {
    stub.restore()
  }
})

test('performRestore 在附件被输入框拒收（正忙）时报错、归还附件，且不置 active', async () => {
  const fetched = recordWith([attachment()], '正文')
  const f = fake(true)
  const stub = stubHost((method) => {
    if (method === 'draft-get') return { ok: true, record: fetched, assetUrls: { [REF]: HOST_URL } }
    return { ok: true }
  })
  try {
    const outcome = await performRestore(ctxWith(f.face), 'sess-now', fetched, f.actions)

    assert.deepEqual(outcome, { ok: false, error: '输入框正忙，附件未能加入；请等当前提交结束后重试', missing: 0 })
    // 失败路径**没有** draft-set-active：列表不能标出一条其实没进输入框的草稿
    assert.deepEqual(stub.methods, ['draft-get'])
    // 半截回弹的两条：不写正文、已建出来的附件归还
    assert.deepEqual(f.order, ['createDrafts', 'addAttachments', 'releaseDraftAttachments'])
    assert.deepEqual(f.released, [[{ id: 'att-new' }]])
    assert.deepEqual(f.drafts, [])
  } finally {
    stub.restore()
  }
})

test('performRestore 在输入动作面缺 setDraft 时把点名错误报出来，同样不置 active', async () => {
  // 第二条失败路径（不经过 fetch 拒收）：证明「失败不置 active」不是只对着一个分支写的
  const fetched = recordWith([], '正文')
  const f = fake()
  const stub = stubHost((method) => {
    if (method === 'draft-get') return { ok: true, record: fetched }
    return { ok: true }
  })
  try {
    const outcome = await performRestore(ctxWith(f.face), 'sess-now', fetched, {})

    assert.deepEqual(outcome, { ok: false, error: 'inputActions.setDraft 不可用：无法把正文写回输入框', missing: 0 })
    assert.deepEqual(stub.methods, ['draft-get'])
    assert.deepEqual(f.order, [])
  } finally {
    stub.restore()
  }
})

// ------------------------------------------------- 置 active 失败不得被吞

test('performRestore 在 draft-set-active 回 ok:false 时仍报成功，但带一句 warning 并留日志', async () => {
  // 这一步会读写 jsonl（真磁盘 I/O）。走到这里正文已经在输入框里、回不去，所以既不能
  // 报成失败（用户会以为要重做一次）、也不能吞掉（列表不会标出「当前」，控制台无声）。
  // 用例把四件一起钉住：ok:true、warning 非空、内容真的进了输入框、有 ERROR 日志。
  const fetched = recordWith([attachment()], '正文')
  const f = fake()
  const stub = stubHost((method) => {
    if (method === 'draft-get') return { ok: true, record: fetched, assetUrls: { [REF]: HOST_URL } }
    if (method === 'draft-set-active') return { ok: false, error: '磁盘只读' }
    return { ok: true }
  })
  const logged = captureErrors()
  try {
    const outcome = await performRestore(ctxWith(f.face), 'sess-now', fetched, f.actions)

    // 内容确实落进了输入框——这才是不把本次报成失败的依据
    assert.equal(outcome.ok, true)
    assert.ok((outcome.warning ?? '').length > 0, 'warning 必须非空')
    assert.deepEqual(outcome, { ok: true, missing: 0, warning: '草稿已回弹，但未能标记为当前草稿' })
    assert.deepEqual(f.order, ['createDrafts', 'addAttachments', 'setDraft'])
    assert.deepEqual(f.drafts, ['正文'])
    assert.deepEqual(f.added, ['att-new'])
    // 置 active 是**试过**了才失败的（不是被跳过）
    assert.deepEqual(stub.methods, ['draft-get', 'draft-set-active'])
    // 静默正是本次要修的病：至少一条带业务上下文（草稿 id）的 ERROR
    assert.equal(logged.lines.length, 1)
    assert.match(logged.lines[0], /标记当前草稿失败/)
    assert.match(logged.lines[0], /drf_1/)
    assert.match(logged.lines[0], /磁盘只读/)
  } finally {
    logged.restore()
    stub.restore()
  }
})

test('performRestore 在 draft-set-active 这一步传输失败（HTTP 500）时同样只回 warning，不报失败', async () => {
  // 与上一条同一种局面、另一条触发路径：hostCall 在非 2xx 时抛。原来它被外层 catch
  // 折成 ok:false，而正文其实已经进了输入框——本用例钉住新的出口。
  const fetched = recordWith([], '正文')
  const f = fake()
  const stub = stubHost((method) => (method === 'draft-get' ? { ok: true, record: fetched } : undefined))
  const logged = captureErrors()
  try {
    const outcome = await performRestore(ctxWith(f.face), 'sess-now', fetched, f.actions)

    assert.equal(outcome.ok, true)
    assert.ok((outcome.warning ?? '').length > 0, 'warning 必须非空')
    assert.deepEqual(outcome, { ok: true, missing: 0, warning: '草稿已回弹，但未能标记为当前草稿' })
    assert.deepEqual(f.drafts, ['正文'])
    assert.deepEqual(stub.methods, ['draft-get', 'draft-set-active'])
    assert.equal(logged.lines.length, 1)
    assert.match(logged.lines[0], /标记当前草稿失败/)
    assert.match(logged.lines[0], /HTTP 500/)
  } finally {
    logged.restore()
    stub.restore()
  }
})

// ------------------------------------------- 只有成功回弹才记下「内容在输入框里」

/**
 * 这一节钉的是 `performRestore` 与协调器之间那一个接口：**成功才记**。
 *
 * 记下来的 id 是「输入框里装着这条草稿」的唯一凭据，输入框变空时协调器据此发出复位请求
 * （清 active 标志 + 清元素激活集，见 active-draft.ts）。记早了（比如回弹一开头就记），
 * 一次失败的回弹会留下凭据，下一次空输入框就去清掉一份**不属于这条草稿**的激活集。
 * 这里不声称任何组件行为——两个 UI 入口是否真的调了 `noteComposerChange` 归人工验收。
 */
test('performRestore 成功后记下「内容在输入框里」：随后的空输入框请求复位一次', async () => {
  const fetched = recordWith([], '正文')
  const f = fake()
  const stub = stubHost((method) => (method === 'draft-get' ? { ok: true, record: fetched } : { ok: true }))
  resetActiveDraftForTest()
  try {
    const outcome = await performRestore(ctxWith(f.face), 'sess-now', fetched, f.actions)
    assert.equal(outcome.ok, true)

    noteComposerChange({ draft: '', attachmentIds: [] })
    // 第二条 draft-set-active 是协调器发的复位请求：id 必须是显式 null（host 靠它区分
    // 「清空」与「置某条为当前」），而不是 undefined 或省略
    assert.deepEqual(stub.bodies, [
      { method: 'draft-get', params: { id: 'drf_1' } },
      { method: 'draft-set-active', params: { id: 'drf_1' } },
      { method: 'draft-set-active', params: { id: null } },
    ])
    // 幂等：同一次清空不会因为再渲染一次而重发
    noteComposerChange({ draft: '', attachmentIds: [] })
    assert.equal(stub.methods.length, 3)
  } finally {
    resetActiveDraftForTest()
    stub.restore()
  }
})

test('performRestore 在 draft-get 失败时不得记下「内容在输入框里」', async () => {
  // 失败路径的第一个形状：host 都没给出记录，输入框一个字节都没动。
  const f = fake()
  const stub = stubHost(() => ({ ok: false, error: '草稿不存在' }))
  resetActiveDraftForTest()
  try {
    const outcome = await performRestore(ctxWith(f.face), 'sess-now', recordWith([], '正文'), f.actions)
    assert.equal(outcome.ok, false)

    noteComposerChange({ draft: '', attachmentIds: [] })
    assert.deepEqual(stub.methods, ['draft-get'], '失败的回弹不得让空输入框发出复位请求')
  } finally {
    resetActiveDraftForTest()
    stub.restore()
  }
})

test('performRestore 在附件被输入框拒收时同样不得记下「内容在输入框里」', async () => {
  // 失败路径的第二个形状（不经过 draft-get 失败分支）：正文没写进输入框、附件已归还，
  // 所以「输入框装着这条草稿」不成立。
  const fetched = recordWith([attachment()], '正文')
  const f = fake(true)
  const stub = stubHost((method) => (method === 'draft-get' ? { ok: true, record: fetched, assetUrls: { [REF]: HOST_URL } } : { ok: true }))
  resetActiveDraftForTest()
  try {
    const outcome = await performRestore(ctxWith(f.face), 'sess-now', fetched, f.actions)
    assert.equal(outcome.ok, false)

    noteComposerChange({ draft: '', attachmentIds: [] })
    assert.deepEqual(stub.methods, ['draft-get'], '失败的回弹不得让空输入框发出复位请求')
  } finally {
    resetActiveDraftForTest()
    stub.restore()
  }
})

test('performRestore 在置 active 失败（只回 warning）时仍记下「内容在输入框里」', async () => {
  // 这条钉住记录的位置与置 active 无关：正文确实进了输入框，元素集也确实被 draft-get
  // 激活了，只是列表徽标没标上。若不记，这份激活集就再也无人清理——正是本次要修的洞。
  const fetched = recordWith([], '正文')
  const f = fake()
  const stub = stubHost((method) => {
    if (method === 'draft-get') return { ok: true, record: fetched }
    if (method === 'draft-set-active') return { ok: false, error: '磁盘只读' }
    return { ok: true }
  })
  const logged = captureErrors()
  resetActiveDraftForTest()
  try {
    const outcome = await performRestore(ctxWith(f.face), 'sess-now', fetched, f.actions)
    assert.deepEqual(outcome, { ok: true, missing: 0, warning: '草稿已回弹，但未能标记为当前草稿' })

    noteComposerChange({ draft: '', attachmentIds: [] })
    assert.deepEqual(stub.bodies.map((b) => b.params), [{ id: 'drf_1' }, { id: 'drf_1' }, { id: null }])
  } finally {
    resetActiveDraftForTest()
    logged.restore()
    stub.restore()
  }
})

// ------------------------------------------------- 回弹前的覆盖确认判定

/**
 * 这里只钉住**判定本身**的真值表：组件是否据此弹确认面板、面板上是什么文案，
 * Node 里无法观测（组件模块 import react），那一步由 Task 10 端到端验证。
 * 用例名因此只说判定，不说「弹面板」。
 */
test('shouldConfirmOverwrite：输入框非空才需要二次确认（空的直接回弹，不加摩擦）', () => {
  // 空输入框没有会被覆盖掉的东西：直接回弹
  assert.equal(shouldConfirmOverwrite('', []), false)
  // 只有空白的正文不算内容（否则敲个空格就要多确认一次）
  assert.equal(shouldConfirmOverwrite('   \n\t ', []), false)
  // 有正文 → 必须确认（setDraft 是整体替换，覆盖掉的内容找不回来）
  assert.equal(shouldConfirmOverwrite('正在写的提示词', []), true)
  // 只有附件、没正文 → 同样会被整体替换掉，同样要确认
  assert.equal(shouldConfirmOverwrite('', ['att-1']), true)
  assert.equal(shouldConfirmOverwrite('   ', ['att-1']), true)
})

// ------------------------------------------------- 提示文案的拼接

/**
 * 只钉住**拼接规则**本身：两个入口是否真的调它、拼出来那句是否显示在屏幕上，Node 里
 * 无法观测（组件模块 import react），那一步由 Task 10 端到端验证。用例名因此只说
 * `restoreNotice`，不说「界面显示了什么」。
 */
test('restoreNotice：成功文案与 warning 同时在，谁都不吞谁', () => {
  const warning = '草稿已回弹，但未能标记为当前草稿'

  // 成功文案在前、警告在后，两段都在（只报成功就没人知道「当前」没标上，只报警告又像失败）
  assert.equal(
    restoreNotice({ ok: true, missing: 0, warning }, '已回弹草稿'),
    '已回弹草稿；' + warning,
  )
  // 成功文案为空串（调用方用它表示「这次不用成功文案」）时，警告必须照常露出，不能被吞
  assert.equal(restoreNotice({ ok: true, missing: 0, warning }, ''), warning)
  // 附件有缺失时是三条信息一起在，不是二选一
  assert.equal(
    restoreNotice({ ok: true, missing: 2, warning }, '已回弹草稿，但有 2 个附件未能恢复'),
    '已回弹草稿，但有 2 个附件未能恢复；' + warning,
  )
  // 没有警告时不多一句话、也不改文案（成功路径的信封形状不变）
  assert.equal(restoreNotice({ ok: true, missing: 0 }, '已回弹草稿'), '已回弹草稿')
  // 也不需要提示时回空串（调用方据此不显示提示条）
  assert.equal(restoreNotice({ ok: true, missing: 0 }, ''), '')
  // 失败：原因原样可展示，且不去拼成功文案（否则会拼出一句自相矛盾的话）
  const failed: RestoreOutcome = { ok: false, error: '草稿不存在', missing: 0 }
  assert.equal(restoreNotice(failed, '已回弹草稿'), '回弹失败：草稿不存在')
  assert.equal(restoreNotice({ ok: false, missing: 0 }, '已回弹草稿'), '回弹失败：未知错误')
})
