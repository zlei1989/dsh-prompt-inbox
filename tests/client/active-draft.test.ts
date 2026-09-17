/**
 * 「当前草稿」协调器（`active-draft.ts`）的用例。
 *
 * 这里钉的是协调器的**判定与一次性闸门**，不是组件行为：两个 UI 入口（`DraftView` /
 * `DraftStrip`）是否真的调了 `noteComposerChange`、输入框清空后请求是否真的发得出去，
 * Node 里观测不到（组件模块 import react，而仓库只装了 `@types/react`，没有 react
 * 运行时），归端到端人工验收。用例名因此只说协调器，不说「界面清空了激活集」。
 *
 * 被测模块只依赖 `fetch` 与模块级状态，所以能在 Node 里跑真身：状态由 `/invoke` 的
 * 请求体观测，宿主由 `fetch` 替身扮演。
 *
 * 传给它的那个观测值就是组件渲染时能给出的东西：`{ draft, attachmentIds }`，或者
 * `undefined`（槽位没给可选 prop `useInput`，组件压根读不到输入框）。**后者不是「空」**，
 * 它有自己的用例——把「观测不到」当成「空」正是这次加固要挡的那个洞。
 */

import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { noteComposerChange, noteRestored, resetActiveDraftForTest } from '../../src/client/active-draft.ts'

/** 每个用例都从「没有回弹记录」的干净状态开始：模块状态是共享的，否则用例之间会串。 */
beforeEach(() => { resetActiveDraftForTest() })

/** 假 host：把 `/invoke` 的信封与请求体记下来，`/asset` 不参与本模块。 */
interface HostStub {
  /** 每次 `/invoke` 的完整请求体（信封里的 method 与 params）。 */
  readonly bodies: { method: string; params: Record<string, unknown> }[]
  /** 每次 `/invoke` 的方法名，按调用顺序（多数断言只关心它）。 */
  readonly methods: string[]
  restore(): void
}

/**
 * @param answer - 按方法名给出 `/invoke` 信封；返回 undefined 表示 HTTP 500（传输层失败）。
 */
function stubHost(
  answer: (method: string, params: Record<string, unknown>) => unknown = () => ({ ok: true }),
): HostStub {
  const original = globalThis.fetch
  const bodies: { method: string; params: Record<string, unknown> }[] = []
  const methods: string[] = []
  // 只关心请求体：本模块的判定全部落在 `/invoke` 的信封上，URL 不参与断言
  globalThis.fetch = ((_input: unknown, init?: { body?: string }) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { method: string; params: Record<string, unknown> }
    methods.push(body.method)
    bodies.push(body)
    const envelope = answer(body.method, body.params)
    return Promise.resolve({
      // 与 hostCall 的约定一致：非 2xx 直接抛（业务失败走 200 上的 ok:false）
      ok: envelope !== undefined,
      status: envelope === undefined ? 500 : 200,
      json: () => Promise.resolve(envelope),
    })
  }) as unknown as typeof fetch
  return { bodies, methods, restore: () => { globalThis.fetch = original } }
}

/**
 * 临时接管 `console.error`（`logError` 的唯一落点），把「失败有没有留痕」变成可断言的。
 * 形状与 restore-action.test.ts 的同名替身一致，用完立刻还回去。
 */
function captureErrors(): { lines: string[]; restore(): void } {
  const original = console.error
  const lines: string[] = []
  console.error = ((...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(' '))
  }) as typeof console.error
  return { lines, restore: () => { console.error = original } }
}

/** 让 fire-and-forget 的 `.then` / `catch` 续体跑完（日志与回复都在微任务里）。 */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
}

// ------------------------------------------------------- 不该发的情况

test('协调器：没有回弹记录时，空输入框不得发出任何请求', async () => {
  // 用户刚打开会话、还没打字——输入框是空的，但没有任何草稿进过输入框。此时若因为
  // 「空」就发复位请求，会清掉上一次回弹留下的元素激活集（那是另一个会话的上下文）。
  const stub = stubHost()
  try {
    noteComposerChange({ draft: '', attachmentIds: [] })
    await flush()
    assert.deepEqual(stub.methods, [])
  } finally {
    stub.restore()
  }
})

test('协调器：回弹记录在案而输入框非空时不得复位（改了但没清空也留着）', async () => {
  // 编辑中的正文对应的仍是同一批 [DOMn]：提前清掉会让模型看不懂正文里的记号，
  // 所以「有内容」就是不动的唯一理由，与内容是否还是原文无关。
  const stub = stubHost()
  try {
    noteRestored('drf_1')
    noteComposerChange({ draft: '我改过的正文', attachmentIds: [] })
    noteComposerChange({ draft: '   ', attachmentIds: ['att-1'] })
    await flush()
    assert.deepEqual(stub.methods, [])
  } finally {
    stub.restore()
  }
})

test('协调器：观测不到输入框（槽位没给 useInput）时不得复位，闸门也不得被消耗', async () => {
  // 「观测不到 ≠ 空」的回归用例：两个入口的输入框现状来自**可选** prop `useInput`，槽位一旦
  // 没给，它们每次渲染都只能报出一个空输入框。若协调器把这份「观测不到」当成空，回弹刚成功、
  // `draft-get` 刚把元素激活集填好，紧接着的那次渲染就会发复位请求——用户的 `[DOMn]` 上下文
  // 会在回弹成功后立刻消失。
  const stub = stubHost()
  try {
    noteRestored('drf_1')
    noteComposerChange(undefined)
    noteComposerChange(undefined)
    await flush()
    assert.deepEqual(stub.methods, [], '观测不到输入框时必须什么都不做')

    // 「未知」既不触发、也不消费闸门：真的观测到空输入框时照常复位一次——否则一次观测不到
    // 就会永久吞掉这轮回弹唯一的复位机会，徽标与元素集再也没人清。
    noteComposerChange({ draft: '', attachmentIds: [] })
    await flush()
    assert.deepEqual(stub.methods, ['draft-set-active'])
  } finally {
    stub.restore()
  }
})

// ------------------------------------------------------- 该发的情况

test('协调器：输入框变成空时发一次 draft-set-active{id:null}（id 必须是显式 null）', async () => {
  // 这是本次修复的核心路径：host 收到 id:null 才会同时清 active 标志与元素激活集。
  // 断言完整信封而不只是方法名——`{ id: undefined }` 会被 JSON.stringify 丢掉该键，
  // 那与「传了 null」在 host 眼里是同一回事，但在契约上是两种意图，必须钉死。
  const stub = stubHost()
  try {
    noteRestored('drf_1')
    noteComposerChange({ draft: '回弹进来的正文', attachmentIds: [] })
    assert.deepEqual(stub.methods, [], '非空输入框不得触发')

    noteComposerChange({ draft: '', attachmentIds: [] })
    await flush()
    assert.deepEqual(stub.bodies, [{ method: 'draft-set-active', params: { id: null } }])
  } finally {
    stub.restore()
  }
})

test('协调器：清空后反复调用（按键 / 重渲染）不得重发第二次', async () => {
  // 两个组件每次渲染都会调它，输入框空着时还会继续渲染。少了模块级闸门，
  // 每一次按键都会重发一条同样的请求，把一个幂等操作变成持续的网络噪音。
  const stub = stubHost()
  try {
    noteRestored('drf_1')
    noteComposerChange({ draft: '', attachmentIds: [] })
    noteComposerChange({ draft: '', attachmentIds: [] })
    noteComposerChange({ draft: '', attachmentIds: [] })
    await flush()
    assert.equal(stub.methods.length, 1, '三次空输入框只应发出一次请求')
    assert.deepEqual(stub.methods, ['draft-set-active'])
  } finally {
    stub.restore()
  }
})

test('协调器：再次回弹会重新武装闸门（同一个会话里的第二轮回弹同样能复位）', async () => {
  // 闸门是「摘掉记录」而不是一次性的进程级开关：用过一次之后，下一次回弹必须能再来一遍。
  const stub = stubHost()
  try {
    noteRestored('drf_1')
    noteComposerChange({ draft: '', attachmentIds: [] })
    noteRestored('drf_2')
    noteComposerChange({ draft: '', attachmentIds: [] })
    await flush()
    assert.deepEqual(stub.methods, ['draft-set-active', 'draft-set-active'])
    assert.deepEqual(stub.bodies.map((b) => b.params), [{ id: null }, { id: null }])
  } finally {
    stub.restore()
  }
})

// ------------------------------------------------------- 失败不得静默

test('协调器：host 回 ok:false 时留一条带草稿 id 的 ERROR，且不重发', async () => {
  // 复位失败是真实的磁盘写失败（jsonl 只读 / 满盘）。这条路径上没有界面能显示它，
  // 所以日志是唯一的出口——静默失败正是本次要修的那类病。
  const stub = stubHost(() => ({ ok: false, error: '磁盘只读' }))
  const logged = captureErrors()
  try {
    noteRestored('drf_1')
    noteComposerChange({ draft: '', attachmentIds: [] })
    await flush()
    assert.equal(logged.lines.length, 1)
    assert.match(logged.lines[0], /清空当前草稿标记失败/)
    assert.match(logged.lines[0], /drf_1/)
    assert.match(logged.lines[0], /磁盘只读/)
    // 不重试：下一次渲染还在空输入框上，重发只会把同一条失败请求打成噪音
    noteComposerChange({ draft: '', attachmentIds: [] })
    await flush()
    assert.equal(stub.methods.length, 1)
  } finally {
    logged.restore()
    stub.restore()
  }
})

test('协调器：复位请求传输失败（HTTP 500）时同样只留 ERROR，不抛给渲染', async () => {
  // hostCall 在非 2xx 时会抛，而调用点在渲染路径上、没有人 catch：
  // 抛出去就是一个未处理的 rejection（界面一片安静）。
  const stub = stubHost(() => undefined)
  const logged = captureErrors()
  try {
    noteRestored('drf_1')
    noteComposerChange({ draft: '', attachmentIds: [] })
    await flush()
    assert.equal(logged.lines.length, 1)
    assert.match(logged.lines[0], /清空当前草稿标记失败/)
    assert.match(logged.lines[0], /HTTP 500/)
  } finally {
    logged.restore()
    stub.restore()
  }
})
