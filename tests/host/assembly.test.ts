import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { apply, inject, name } from '../../src/host/index.ts'
import { createAssetStore, refToPath } from '../../src/host/asset-store.ts'
import { createDraftStore } from '../../src/host/draft-store.ts'
import type { WebRequestLike, WebResponseLike } from '../../src/host/services.ts'
import type { DraftRecord } from '../../src/shared/types.ts'

/**
 * host 装配（src/host/index.ts）的判别性用例。
 *
 * Task 5 要求里有三条只写在散文里、没有测试就完全不可观测的行为：
 *   - 两条路由真的接到 webServer 上，且卸载时被撤销；
 *   - 启动时跑一次孤儿资产 GC（「整次超限」失败留下的字节不该永久占盘）；
 *   - 这次 GC 失败只告警，不得拖垮插件激活。
 * Task 6 又补上一条同类行为：模型面（工具 + 提示段）接在**活**元素激活集上——
 * 两者各自的单测都是注入假 registry，只有从这里走一遍 `/invoke` 的 draft-get
 * 才观测得到「回弹草稿 → 模型查得到」这条链。
 * 这些都在这里钉住——否则改坏了也没有任何用例会红。
 */

/** 登记到假工具表里的一条工具声明（形状与 ToolsFace.register 的入参一致）。 */
interface RegisteredTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: { schema: Record<string, unknown>; render(args: unknown, value: unknown): unknown[] }
  execute(args: unknown): Promise<unknown>
}

/** 一条被登记的提示上下文段（形状与 SystemPromptFace.context 的入参一致）。 */
interface RegisteredContext {
  name: string
  order: number
  text: () => string
}

/** 假 harness 面：apply 用到的三个服务 + 登记到 effect 的清理器，全部留作断言素材。 */
interface FakeHarness {
  ctx: Context
  /** 交给 ctx.effect 的清理器，按登记顺序。 */
  disposers: Array<() => void>
  /** 被登记的路由，带 handler：模型面的用例靠它走一遍 `/invoke`。 */
  routes: Array<{ path: string; handler: (req: WebRequestLike, res: WebResponseLike) => void | Promise<void> }>
  /** 被登记的工具，按名字索引。 */
  tools: Map<string, RegisteredTool>
  /** 被登记的提示上下文段，按名字索引。 */
  contexts: Map<string, RegisteredContext>
}

/** 装配用假 ctx：只实现 apply 真正用到的三个服务与 effect。 */
function fakeContext(routePaths: string[]): FakeHarness {
  const disposers: Array<() => void> = []
  const routes: FakeHarness['routes'] = []
  const tools = new Map<string, RegisteredTool>()
  const contexts = new Map<string, RegisteredContext>()
  const webServer = {
    // 端口只被元素来源用到；这里不构造真实来源，0 表示「没有真实监听」
    port: 0,
    register: (route: FakeHarness['routes'][number]) => {
      routePaths.push(route.path)
      routes.push(route)
      return () => {
        const index = routePaths.indexOf(route.path)
        if (index >= 0) routePaths.splice(index, 1)
        const at = routes.indexOf(route)
        if (at >= 0) routes.splice(at, 1)
      }
    },
  }
  const toolFace = {
    register: (definition: RegisteredTool) => {
      tools.set(definition.name, definition)
      return () => { tools.delete(definition.name) }
    },
  }
  const promptFace = {
    context: (declaration: RegisteredContext) => {
      contexts.set(declaration.name, declaration)
      return () => { contexts.delete(declaration.name) }
    },
  }
  const ctx = {
    get: (serviceName: string) => {
      if (serviceName === 'webServer') return webServer
      if (serviceName === 'tools') return toolFace
      if (serviceName === 'systemPrompt') return promptFace
      return undefined
    },
    // 与 Cordis 一致：effect 立刻执行回调，并收集它返回的清理器
    effect: (callback: () => unknown) => {
      const dispose = callback()
      if (typeof dispose === 'function') disposers.push(dispose as () => void)
    },
  } as unknown as Context
  return { ctx, disposers, routes, tools, contexts }
}

/** 每个用例一个独立的临时目录，绝不碰用户真实的 $DSH_HOME。 */
function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'pi-assembly-'))
}

/** 收集并静音本插件经 console 输出的日志（log* 系列直接走 console）。 */
function captureLogs(): { infos: string[]; warns: string[]; restore: () => void } {
  const infos: string[] = []
  const warns: string[] = []
  const originalInfo = console.info
  const originalWarn = console.warn
  console.info = (msg?: unknown) => { infos.push(String(msg)) }
  console.warn = (msg?: unknown) => { warns.push(String(msg)) }
  return {
    infos,
    warns,
    restore: () => {
      console.info = originalInfo
      console.warn = originalWarn
    },
  }
}

/**
 * 用假 req/res 走一遍 `/invoke` 路由处理器。
 *
 * registry 是 apply 内部的局部变量，外部唯一能让它载入元素的路径就是 draft-get
 * ——而那正是回弹草稿时真实发生的事。body 一次给完，再等一个宏任务，让
 * `void (async () => …)()` 的分发落地。
 */
async function postInvoke(
  handler: (req: WebRequestLike, res: WebResponseLike) => void | Promise<void>,
  envelope: Record<string, unknown>,
): Promise<{ status: number; json: unknown }> {
  const listeners = new Map<string, Array<(arg?: unknown) => void>>()
  const req = {
    method: 'POST',
    url: '/dsh-prompt-inbox/invoke',
    on: (event: string, callback: (arg?: unknown) => void) => {
      const list = listeners.get(event) ?? []
      list.push(callback)
      listeners.set(event, list)
    },
  } as unknown as WebRequestLike
  let status = 0
  let body = ''
  const res = {
    writeHead: (code: number) => { status = code },
    end: (value: string | Uint8Array) => {
      body = typeof value === 'string' ? value : Buffer.from(value).toString('utf8')
    },
  } as unknown as WebResponseLike

  await handler(req, res)
  for (const callback of listeners.get('data') ?? []) callback(Buffer.from(JSON.stringify(envelope), 'utf8'))
  for (const callback of listeners.get('end') ?? []) callback()
  await new Promise<void>((resolve) => { setImmediate(() => { resolve() }) })
  return { status, json: JSON.parse(body) as unknown }
}

test('host 入口契约：name/inject 齐全，且没有 default 导出', async () => {
  const mod = (await import('../../src/host/index.ts')) as Record<string, unknown>
  assert.equal(name, 'dsh-prompt-inbox')
  assert.deepEqual(inject, ['tools', 'systemPrompt', 'webServer'])
  // default 导出会让 Loader 的 unwrapExports（exports.default ?? exports）把模块
  // 坍缩成裸函数并丢掉 inject，导致 apply 与服务纤程竞态（AGENT.md 硬约束）
  assert.equal('default' in mod, false, 'host 入口不得有 default 导出')
})

test('apply 装配 /invoke 与 /asset 两条路由，清理器撤销两条', () => {
  const root = tempDir()
  const routes: string[] = []
  const { ctx, disposers } = fakeContext(routes)
  const logs = captureLogs()
  try {
    apply(ctx, { logPath: join(root, 'prompt-inbox.jsonl'), assetsDir: join(root, 'assets') })
  } finally {
    logs.restore()
  }
  assert.deepEqual(routes.slice().sort(), ['/dsh-prompt-inbox/asset', '/dsh-prompt-inbox/invoke'])
  assert.equal(disposers.length, 3, '路由、工具、提示段三个副作用都必须经 ctx.effect 登记')
  disposers[0]!()
  assert.deepEqual(routes, [], '卸载后两条路由都要撤销')
})

test('apply 启动时清扫孤儿资产，但保留记录仍引用的资产', () => {
  const root = tempDir()
  const logPath = join(root, 'prompt-inbox.jsonl')
  const assetsDir = join(root, 'assets')

  // 被引用的一份字节：写进日志的记录指向它，清扫必须放过它
  const assets = createAssetStore({ root: assetsDir })
  const kept = assets.put(new Uint8Array([1, 2, 3]))
  const record: DraftRecord = {
    id: 'drf_kept',
    createdAt: 1,
    originSessionId: 'sess-1',
    active: false,
    content: {
      text: 'x',
      elements: [],
      attachments: [{ name: 'a.txt', mediaType: 'text/plain', size: 3, kind: 'file', asset: { sha256: kept.sha256, ref: kept.ref }, degraded: false }],
    },
  }
  createDraftStore({ logPath }).appendUpsert(record)

  // 孤儿一份：模仿「整次超限」失败时已经落盘、却没有记录引用的字节
  const orphanPath = refToPath(assetsDir, 'sha256/ab/' + 'ab'.repeat(32) + '.bin')
  mkdirSync(dirname(orphanPath), { recursive: true })
  writeFileSync(orphanPath, 'orphan bytes')

  const { ctx } = fakeContext([])
  const logs = captureLogs()
  try {
    apply(ctx, { logPath, assetsDir })
  } finally {
    logs.restore()
  }

  assert.equal(existsSync(orphanPath), false, '无引用的孤儿字节应在启动时被回收')
  assert.equal(existsSync(refToPath(assetsDir, kept.ref)), true, '仍被记录引用的资产不得被清扫')
  assert.match(logs.infos.join('\n'), /启动清扫回收了 1 个孤儿资产文件/)
})

test('启动清扫失败只告警，装配照常完成', () => {
  const root = tempDir()
  const assetsDir = join(root, 'assets')
  // 故障注入：把分片根目录做成文件 → collectGarbage 里的 readdirSync 抛 ENOTDIR
  mkdirSync(assetsDir, { recursive: true })
  writeFileSync(join(assetsDir, 'sha256'), 'not a directory')

  const routes: string[] = []
  const { ctx, disposers } = fakeContext(routes)
  const logs = captureLogs()
  try {
    assert.doesNotThrow(
      () => apply(ctx, { logPath: join(root, 'prompt-inbox.jsonl'), assetsDir }),
      '清扫失败不得让插件激活失败',
    )
  } finally {
    logs.restore()
  }
  assert.deepEqual(routes.slice().sort(), ['/dsh-prompt-inbox/asset', '/dsh-prompt-inbox/invoke'])
  assert.equal(disposers.length, 3)
  assert.equal(logs.warns.length, 1)
  assert.match(logs.warns[0]!, /启动期孤儿资产清扫失败/)
})

test('非法配置逐键告警并退回默认值，激活照常完成', () => {
  const root = tempDir()
  const routes: string[] = []
  const { ctx } = fakeContext(routes)
  const logs = captureLogs()
  const previousHome = process.env.DSH_HOME
  // 让「退回默认值」那条路径也落在临时目录里，别读写用户真实的 ~/.dsh
  process.env.DSH_HOME = join(root, 'dsh-home')
  try {
    apply(ctx, {
      // YAML 配置没有 schema 校验，非法值必须在这里被挡下（而不是让激活失败）
      logPath: '   ',
      maxAttachmentBytes: -1,
      maxRecords: 'many' as unknown as number,
      assetsDir: join(root, 'assets'),
    })
  } finally {
    logs.restore()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
  assert.equal(routes.length, 2, '非法配置不应阻止路由装配')
  assert.equal(logs.warns.length, 3, '三个非法键各告警一次')
  assert.match(logs.warns.join('\n'), /logPath/)
  assert.match(logs.warns.join('\n'), /maxAttachmentBytes/)
  assert.match(logs.warns.join('\n'), /maxRecords/)
})

test('apply 把模型面接在活注册集上：回弹草稿后工具与提示段都读得到那批元素', async () => {
  const root = tempDir()
  const logPath = join(root, 'prompt-inbox.jsonl')
  const assetsDir = join(root, 'assets')

  // 先落一条带 [DOMn] 的草稿：apply 的 store 在构造时读它，之后 draft-get 才取得到
  const draft: DraftRecord = {
    id: 'drf_1',
    createdAt: 1,
    originSessionId: 'sess-1',
    active: false,
    content: {
      text: '看看 [DOM14] 是什么',
      attachments: [],
      elements: [{ id: 'DOM14', label: '完全权限', pageUrl: 'http://127.0.0.1:3080/', payload: null, degraded: true }],
    },
  }
  createDraftStore({ logPath }).appendUpsert(draft)

  const harness = fakeContext([])
  const logs = captureLogs()
  try {
    apply(harness.ctx, { logPath, assetsDir })
  } finally {
    logs.restore()
  }

  const section = harness.contexts.get('prompt-inbox')
  assert.ok(section !== undefined, 'apply 必须注册名为 prompt-inbox 的提示上下文段')
  const tool = harness.tools.get('prompt_inbox_element')
  assert.ok(tool !== undefined, 'apply 必须注册 prompt_inbox_element 工具')

  // 注册时激活集还是空的：这一行钉住「提示段是现算的」，而不是注册时抓的一份快照
  assert.equal(section!.text(), '', '没有激活元素时提示段不占上下文')

  // 回弹：正是这一步把草稿里的元素快照载入激活集
  const invoke = harness.routes.find(route => route.path === '/dsh-prompt-inbox/invoke')
  assert.ok(invoke !== undefined, '装配必须登记 /invoke 路由')
  const answer = await postInvoke(invoke!.handler, { method: 'draft-get', params: { id: 'drf_1' } })
  assert.equal(answer.status, 200)
  assert.equal((answer.json as { ok?: boolean }).ok, true, 'draft-get 必须成功，否则后面的断言测的不是模型面')

  const text = section!.text()
  assert.match(text, /DOM14/)
  assert.match(text, /完全权限/)
  assert.match(text, /来源：草稿 drf_1/)
  const value = (await tool!.execute({ id: 'DOM14' })) as { ok?: boolean; label?: string; payloadAvailable?: boolean; note?: string }
  assert.equal(value.ok, true, '工具必须查得到提示段列出的同一个编号')
  assert.equal(value.label, '完全权限')
  assert.equal(value.payloadAvailable, false, '摘要模式下必须如实回报 payload 不可得')
  // 与 tools.test.ts 的同一条钉子一致：只看 /不可得|摘要/ 会被一字编造的 note 骗过，
  // 这句说明的全部价值在于点出「谁挡住了载荷、载荷去哪了」
  assert.match(String(value.note), /dsh-webpage-element-picker/, 'note 必须点出挡住载荷的来源')
  assert.match(String(value.note), /未保存/, 'note 必须说明载荷没有被保存')

  // 卸载：工具与提示段都是经 ctx.effect 登记的，必须一起被撤销
  for (const dispose of harness.disposers) dispose()
  assert.equal(harness.tools.size, 0, '卸载后工具必须被撤销')
  assert.equal(harness.contexts.size, 0, '卸载后提示段必须被撤销')
})
