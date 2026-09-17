import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDraftStore } from '../../src/host/draft-store.ts'
import { createAssetStore } from '../../src/host/asset-store.ts'
import type { AssetStore } from '../../src/host/asset-store.ts'
import { createDraftService } from '../../src/host/draft-service.ts'
import { createElementRegistry } from '../../src/host/element-registry.ts'
import { createHandlers, registerInvokeRoute } from '../../src/host/routes.ts'
import type { InvokeResult } from '../../src/shared/types.ts'

/**
 * 兜底清理表：断言失败时测试体会在 `await s.close()` 之前抛出，监听中的 server
 * 就再也没人关，事件循环不退、整个文件的汇总永远打不出来（表现为「失败即挂起」）。
 * 这里在文件末尾统一兜住——断言照旧在原处关闭，重复关闭是幂等的。
 */
const openServers: Array<() => Promise<void>> = []
after(async () => {
  for (const close of openServers) await close()
})

/**
 * 第二遍请求体：把 body 的字节**切成两块分两次 `write()`**，并在两次之间留出
 * 间隔，让服务端真的收到两个 `data` 事件。
 *
 * 这是唯一能观测到「逐 chunk 解码」缺陷的送法：`fetch`/`write(body)` 一次给完时
 * 整个 body 落在同一个 chunk 里，切不出半个多字节字符，缺陷就永远是隐形的。
 */
async function sendInTwoWrites(
  url: string,
  first: Buffer,
  second: Buffer,
  gapMs = 60,
): Promise<{ status: number; text: string }> {
  return await new Promise((resolve, reject) => {
    const req = request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // 显式给出长度：分两次写时 Node 默认会改用 chunked，长度固定更接近客户端真实行为
        'Content-Length': String(first.byteLength + second.byteLength),
      },
    }, (res) => {
      const parts: Buffer[] = []
      res.on('data', (chunk: Buffer) => { parts.push(chunk) })
      res.on('end', () => { resolve({ status: res.statusCode ?? 0, text: Buffer.concat(parts).toString('utf8') }) })
    })
    req.on('error', reject)
    req.write(first)
    setTimeout(() => { req.end(second) }, gapMs)
  })
}

/**
 * `JSON.stringify` 不转义非 ASCII：中文正文在请求体里是**真的 UTF-8 多字节**
 * （一个汉字 3 字节），socket 按 64KB 分块时完全可能从汉字中间切开。
 *
 * 返回 `text` 里第 `characterIndex` 个字符**内部**的字节偏移：先定位该字符的
 * 首字节，再字节级推进 `bytesIntoCharacter`（默认 1，即切出一个不完整的
 * 多字节序列）。注意不能只算「前 N 个字符的字节总数」——那正好落在字符边界上，
 * 逐 chunk 解码不会出错，用例就变成了假绿。
 */
function splitInsideCharacter(text: string, characterIndex: number, bytesIntoCharacter = 1): number {
  const lead = Buffer.byteLength(text.slice(0, characterIndex), 'utf8')
  return lead + bytesIntoCharacter
}

/**
 * 带死线的 GET/POST 缺省超时：**每个请求都该有**。
 *
 * 只给新加的用例加死线不够：任何一条「路由没写出任何响应」的回归都会让客户端
 * 一直挂着等，`node --test` 永远打不出汇总行（表现为超时而不是失败），
 * 而文件级的 after() 救不了它——客户端收不到响应就永远不会释放连接。
 * 给每个请求一个上限，让它退化成干净的断言失败，而不是把整个测试进程拖死。
 */
const DEADLINE_MS = 3000

/**
 * 带死线的 GET。
 */
async function fetchWithDeadline(url: string): Promise<Response> {
  return await fetch(url, { signal: AbortSignal.timeout(DEADLINE_MS) })
}

/** 起一个真实 HTTP 服务把路由挂上去，用 fetch 走真链路。 */
async function serve(overrides: { maxBodyBytes?: number; assets?: AssetStore } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pi-routes-'))
  const assets = overrides.assets ?? createAssetStore({ root: join(root, 'assets') })
  const service = createDraftService({
    store: createDraftStore({ logPath: join(root, 'prompt-inbox.jsonl') }),
    assets,
    elements: { lookup: async (ids) => ids.map((id) => ({ id, label: 'L' + id, payload: null, degraded: true })) },
    maxAttachmentBytes: 1024,
    maxDraftBytes: 4096,
    maxRecords: 500,
  })
  const registry = createElementRegistry()
  const handlers = createHandlers({ service, assets, registry })

  const routes: Array<{ path: string; handler: (req: never, res: never) => void }> = []
  const dispose = registerInvokeRoute({
    // 端口只有元素来源会用到，这个 mock 不构造元素来源，0 表示「没有真实监听」
    webServer: { register: (route) => { routes.push(route as never); return () => {} }, port: 0 },
    path: '/dsh-prompt-inbox/invoke',
    handlers,
    // /asset 路由按 ref 读字节，必须拿到同一个 store：没有它这条路由只能是死的
    assets,
    maxBodyBytes: overrides.maxBodyBytes ?? 8 * 1024 * 1024,
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  })
  // registerInvokeRoute 会注册 /invoke 与 /asset 两条路由，这里按 pathname 分派，
  // 不能按下标取——否则测试会打到错的路由并且看起来还能过
  //
  // chunkObserver 只用来**确认服务端到底收到了几个 chunk、边界落在哪个字节偏移**：
  // 「多字节字符被切开」这件事必须能被观测，否则两个 chunk 万一被合并成一个，
  // 用例会假绿。它不参与解码，只记账，所以不影响被测行为。
  let chunkObserver: ((chunk: Buffer, offset: number) => void) | undefined
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    const route = routes.find((r) => r.path === pathname)
    if (route === undefined) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'no route' }))
      return
    }
    // 偏移按连接独立累计：跨连接共享计数器会让第二个请求的边界变成
    // 「上一条连接的总字节 + 偏移」，断言失败时给不出可解释的数字
    let seenBytes = 0
    req.on('data', (chunk: Buffer) => {
      const offset = seenBytes
      seenBytes += chunk.byteLength
      chunkObserver?.(chunk, offset)
    })
    route.handler(req as never, res as never)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => { resolve() }))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const base = 'http://127.0.0.1:' + port + '/dsh-prompt-inbox/invoke'
  const call = async (method: string, params: Record<string, unknown> = {}): Promise<InvokeResult> => {
    const res = await fetch(base, {
      signal: AbortSignal.timeout(3000),
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, params }),
    })
    assert.equal(res.status, 200, method + ' 应回 200（业务失败走 ok:false）')
    return (await res.json()) as InvokeResult
  }
  const close = async () => {
    dispose()
    // 先掐掉 keep-alive 连接再 close：否则 server.close() 要等 5s keep-alive
    // 超时才回调，11 个用例就是一分钟
    server.closeAllConnections()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  }
  openServers.push(close)
  return {
    call, service, assets, registry, base, close,
    /** 安装请求体 chunk 记账（每个连接各自装一次，只保留最近一次）。 */
    observeChunks: (fn: (chunk: Buffer, offset: number) => void) => { chunkObserver = fn },
    assetBase: 'http://127.0.0.1:' + port + '/dsh-prompt-inbox/asset',
  }
}

test('draft-save 落记录，draft-list 读回来', async () => {
  const s = await serve()
  const saved = await s.call('draft-save', { payload: { text: 'hi [DOM1]', originSessionId: 'sess-1', attachments: [], elements: [] } })
  assert.equal(saved.ok, true)
  assert.ok(saved.record)
  const listed = await s.call('draft-list')
  assert.equal(listed.records?.length, 1)
  await s.close()
})

test('draft-save 返回的 elements 标 degraded', async () => {
  const s = await serve()
  const saved = await s.call('draft-save', { payload: { text: 'x [DOM7]', originSessionId: 'sess-1', attachments: [], elements: [] } })
  assert.equal(saved.record?.content.elements[0]?.id, 'DOM7')
  assert.equal(saved.record?.content.elements[0]?.degraded, true)
  await s.close()
})

test('draft-get 回记录与资产 URL，并激活元素集', async () => {
  const s = await serve()
  const saved = await s.call('draft-save', {
    payload: {
      text: 'x [DOM7]', originSessionId: 'sess-1', elements: [],
      attachments: [{ name: 'a.txt', mediaType: 'text/plain', size: 3, kind: 'file', base64: Buffer.from('abc').toString('base64') }],
    },
  })
  const id = saved.record!.id
  const got = await s.call('draft-get', { id })
  assert.equal(got.ok, true)
  assert.equal(got.record?.id, id)
  const ref = got.record!.content.attachments[0]!.asset!.ref
  assert.ok(got.assetUrls?.[ref], '应给出该资产的读取 URL')
  assert.equal(s.registry.list().length, 1, '回弹应激活元素集')
  await s.close()
})

test('draft-get 对未知 id 回 ok:false', async () => {
  const s = await serve()
  const got = await s.call('draft-get', { id: 'drf_nope' })
  assert.equal(got.ok, false)
  assert.match(String(got.error), /未找到/)
  await s.close()
})

test('draft-remove 删除并回收资产', async () => {
  const s = await serve()
  const saved = await s.call('draft-save', {
    payload: {
      text: 'x', originSessionId: 'sess-1', elements: [],
      attachments: [{ name: 'a.txt', mediaType: 'text/plain', size: 3, kind: 'file', base64: Buffer.from('abc').toString('base64') }],
    },
  })
  const ref = saved.record!.content.attachments[0]!.asset!.ref
  const removed = await s.call('draft-remove', { id: saved.record!.id })
  assert.equal(removed.ok, true)
  assert.equal(s.assets.has(ref), false)
  await s.close()
})

test('draft-set-active 只把目标置为 active', async () => {
  const s = await serve()
  const a = await s.call('draft-save', { payload: { text: 'a', originSessionId: 's', attachments: [], elements: [] } })
  const b = await s.call('draft-save', { payload: { text: 'b', originSessionId: 's', attachments: [], elements: [] } })
  await s.call('draft-set-active', { id: b.record!.id })
  const listed = await s.call('draft-list')
  const byId = new Map(listed.records!.map((r) => [r.id, r.active]))
  assert.equal(byId.get(a.record!.id), false)
  assert.equal(byId.get(b.record!.id), true)
  await s.close()
})

test('draft-set-active 传 null 清空全部 active', async () => {
  const s = await serve()
  const a = await s.call('draft-save', { payload: { text: 'a', originSessionId: 's', attachments: [], elements: [] } })
  await s.call('draft-set-active', { id: a.record!.id })
  await s.call('draft-set-active', { id: null })
  const listed = await s.call('draft-list')
  assert.equal(listed.records?.[0]?.active, false)
  await s.close()
})

test('draft-set-active 传 null 连带清空元素激活集（提示段不得再声称编号对应当前消息）', async () => {
  // 判别性用例：只清 active、把激活集留着，系统提示段会继续列出那批 [DOMn] 并声称
  // 「用户消息中的编号与下列一一对应」——而输入框早已清空，那条草稿甚至可能已被删除。
  // 所以这里必须同时钉住两半：element-list 为空 **且** 每条记录的 active 都为 false。
  const s = await serve()
  const a = await s.call('draft-save', { payload: { text: '甲 [DOM3]', originSessionId: 's', attachments: [], elements: [] } })
  const b = await s.call('draft-save', { payload: { text: '乙 [DOM4]', originSessionId: 's', attachments: [], elements: [] } })

  await s.call('draft-get', { id: a.record!.id })
  assert.equal((await s.call('element-list')).records?.length, 1, '前置：回弹后激活集应有 1 条')

  // 前置（判别性）：只有 id 为 null 才清。少了这一条，一个「无条件 clear」的实现也能过下面的断言。
  await s.call('draft-set-active', { id: b.record!.id })
  assert.equal((await s.call('element-list')).records?.length, 1, '前置：置某条为当前不得清空激活集')

  await s.call('draft-set-active', { id: null })
  assert.equal((await s.call('element-list')).records?.length ?? 0, 0, '输入框清空后激活集必须为空')

  const listed = await s.call('draft-list')
  const byId = new Map(listed.records!.map((r) => [r.id, r.active]))
  assert.equal(byId.get(a.record!.id), false, '清空后不得留下 active 标志')
  assert.equal(byId.get(b.record!.id), false, '清空后不得留下 active 标志')
  await s.close()
})

test('unknown method 回 ok:false 而不是抛', async () => {
  const s = await serve()
  const res = await s.call('nope')
  assert.equal(res.ok, false)
  assert.match(String(res.error), /未知方法/)
  await s.close()
})

test('超 maxBodyBytes 时回 413', async () => {
  const s = await serve({ maxBodyBytes: 64 })
  const res = await fetch(s.base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method: 'draft-list', params: { pad: 'x'.repeat(4096) } }),
  })
  assert.equal(res.status, 413)
  await s.close()
})

test('请求体跨 chunk 切断多字节字符时不得解出 U+FFFD（中文正文完整性）', async () => {
  // 判别性用例：现有用例都用 fetch 一次给完整 body，整个 body 落在同一个 chunk 里，
  // 逐 chunk `String(chunk)` 解码的缺陷在那种送法下**永远观测不到**。
  // 这里分两次 write，且切点落在一个汉字（3 字节）的**内部**——第一块以该字的
  // 首字节收尾，后两个字节留在第二块。逐 chunk 解码会把这个残字解成 U+FFFD，
  // 正文静默损坏，而 JSON 仍然能解析、长度也可能对得上，所以只有逐字断言正文才能发现它。
  const s = await serve()
  const text = '中文提示词'.repeat(600) + '[DOM1]'
  const body = JSON.stringify({ method: 'draft-save', params: { payload: { text, originSessionId: 'sess-cn', attachments: [], elements: [] } } })
  const bytes = Buffer.from(body, 'utf8')
  const textStart = Buffer.byteLength(body.slice(0, body.indexOf(text)), 'utf8')
  // 第 1000 个汉字「中」的首字节之后再切一刀：第一块以它的首字节收尾，后两个字节留在第二块
  const split = textStart + splitInsideCharacter(text, 1000)
  const first = bytes.subarray(0, split)
  const second = bytes.subarray(split)

  const boundaries: number[] = []
  s.observeChunks((chunk, offset) => { boundaries.push(offset + chunk.byteLength) })
  const res = await sendInTwoWrites(s.base, first, second)

  // 前置断言：两个 chunk 必须真的分两次到达，且切点落在字符内部。
  // 少了这两条，「正文没坏」也可能只是因为服务端把两个 chunk 合成一个收到了（假绿）；
  // 或者切点恰好落在字符边界上，那时逐 chunk 解码本来就不会坏（同样是假绿）。
  assert.deepEqual(boundaries, [split, bytes.byteLength], '前置：服务端必须真的收到两个 chunk，切点即边界')
  assert.equal(first[first.byteLength - 1]! & 0xc0, 0xc0, '前置：被切开的汉字首字节必须是首字节（11xxxxxx），才说明切在字符内部')

  assert.equal(res.status, 200)
  assert.equal(res.text.includes('\uFFFD'), false, '响应里不得出现替换字符：被切断的字符必须在解码前拼回去')
  const saved = JSON.parse(res.text) as InvokeResult
  assert.equal(saved.ok, true)
  assert.equal(saved.record?.content.text, text, '正文必须逐字还原')
  assert.equal(saved.record?.content.text.length, text.length)
  await s.close()
})

test('体积上限量的是字节而不是 UTF-16 码元（中文按 3 字节计）', async () => {
  // 判别性用例：`String.length` 数的是 UTF-16 码元，中文只算 1，于是同一段中文
  // 在「字节上限」下会被少算到 1/3。这里两个 body 的 `String.length` 都在上限
  // 之下，区分它们的只有字节数——按码元量的实现会连 2.4KB 那份一起放行。
  const s = await serve({ maxBodyBytes: 2048 })
  const envelope = (text: string): string =>
    JSON.stringify({ method: 'draft-save', params: { payload: { text, originSessionId: 'sess-cn', attachments: [], elements: [] } } })
  const post = async (body: string): Promise<Response> =>
    await fetch(s.base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })

  const smallText = '中'.repeat(600)
  const small = envelope(smallText)
  assert.ok(small.length < 2048, '前置：这份 body 的 UTF-16 长度在上限之下')
  assert.ok(Buffer.byteLength(small, 'utf8') < 2048, '前置：它的字节数也要在上限之下才配当正例')
  const smallRes = await post(small)
  assert.equal(smallRes.status, 200, '字节数在上限之内的中文正文必须照常走通')
  const smallBody = await smallRes.json() as InvokeResult
  assert.equal(smallBody.record?.content.text, smallText, '正例的正文必须逐字落盘')

  const big = envelope('中'.repeat(800))
  assert.ok(big.length < 2048, '前置：这份 body 的 UTF-16 长度同样在上限之下，按码元量根本判不出来')
  assert.ok(Buffer.byteLength(big, 'utf8') > 2048, '前置：它的 UTF-8 字节数必须真的超上限')
  const bigRes = await post(big)
  assert.equal(bigRes.status, 413, '字节数超上限必须回 413（按码元量会漏放）')
  const bigBody = await bigRes.json() as { ok?: unknown; error?: unknown }
  assert.equal(bigBody.ok, false)
  assert.match(String(bigBody.error), /过大/)
  await s.close()
})

test('element-list 在回弹后返回激活集', async () => {
  const s = await serve()
  const saved = await s.call('draft-save', { payload: { text: '[DOM3]', originSessionId: 's', attachments: [], elements: [] } })
  const before = await s.call('element-list')
  assert.equal(before.records?.length ?? 0, 0, '未回弹时激活集为空')
  await s.call('draft-get', { id: saved.record!.id })
  const after = await s.call('element-list')
  assert.equal(after.records?.length, 1, '回弹后激活集应有 1 条')
  assert.equal(after.records?.[0]?.id, 'DOM3')
  await s.close()
})

test('资产路由拒绝路径穿越形状的 ref', async () => {
  const s = await serve()
  const evil = await fetch(s.assetBase + '?ref=' + encodeURIComponent('../../etc/passwd'))
  assert.equal(evil.status, 400, '不合白名单形状的 ref 必须回 400')
  await s.close()
})

test('资产路由：形状白名单先于 assets.read（正例同场作对照）', async () => {
  // 判别性用例：只断言「不合形状回 400」是不够的——先 read、读不到再回 400 的实现
  // 同样能过那条用例。这里用一个记账的 store，把「read 到底有没有被调用」变成可观测量。
  const real = createAssetStore({ root: join(mkdtempSync(join(tmpdir(), 'pi-asset-')), 'assets') })
  const seeded = real.put(new Uint8Array([1, 2, 3]))
  const reads: string[] = []
  const spy: AssetStore = {
    put: (bytes) => real.put(bytes),
    read: (ref) => { reads.push(ref); return real.read(ref) },
    has: (ref) => real.has(ref),
    collectGarbage: (referenced) => real.collectGarbage(referenced),
  }
  const s = await serve({ assets: spy })

  const evil = await fetch(s.assetBase + '?ref=' + encodeURIComponent('../../etc/passwd'))
  assert.equal(evil.status, 400)
  assert.deepEqual(reads, [], '不合形状的 ref 在校验被摘掉之前不得触碰 assets.read')

  // 正对照：同一条路由 + 同一个 store，合法形状的 ref 必须真的读到字节。
  // 少了这一半，「reads 为空」也可能只是因为这条路由根本读不到任何东西
  const hit = await fetch(s.assetBase + '?ref=' + encodeURIComponent(seeded.ref))
  assert.equal(hit.status, 200)
  assert.deepEqual([...new Uint8Array(await hit.arrayBuffer())], [1, 2, 3])
  assert.deepEqual(reads, [seeded.ref], '合法 ref 必须且只读一次')
  await s.close()
})

test('资产路由只收 GET、invoke 路由只收 POST（方法形状错误回非 200）', async () => {
  const s = await serve()
  const ref = 'sha256/00/' + '0'.repeat(64) + '.bin'
  const wrongVerb = await fetch(s.assetBase + '?ref=' + encodeURIComponent(ref), { method: 'POST' })
  assert.equal(wrongVerb.status, 405)
  const wrongInvoke = await fetch(s.base, { method: 'GET' })
  assert.equal(wrongInvoke.status, 405)
  await s.close()
})

test('资产路由：形状合法但盘上没有该文件时回 404 JSON', async () => {
  // 判别性用例：形状白名单那一关过后还有一条分支——ref 合法、字节却不在盘上
  // （外部删掉了附件）。这条分支此前没有任何用例，而它一旦退化（例如 read 改成
  // 返回 undefined 而不是抛），200 那条路径会在 bytes.byteLength 上抛进
  // 「业务失败也回 200」的 catch 里：既没走这条 404，也没写出任何响应，客户端直接挂住。
  // 所以这里必须断言「有响应且是 404」，而不是只断言「不是 200」；请求带死线，
  // 免得那种坏情况把测试进程一起拖死（诊断见 fetchWithDeadline 的注释）。
  const s = await serve()
  const missing = 'sha256/ab/' + 'ab'.repeat(32) + '.bin'
  assert.equal(s.assets.has(missing), false, '前置：这个 ref 在盘上确实不存在')

  const res = await fetchWithDeadline(s.assetBase + '?ref=' + encodeURIComponent(missing))
  assert.equal(res.status, 404)
  assert.match(String(res.headers.get('content-type')), /application\/json/, '404 必须是 JSON 信封而不是空响应')
  const body = await res.json() as { ok?: unknown; error?: unknown }
  assert.equal(body.ok, false)
  assert.match(String(body.error), /资产不存在/)
  await s.close()
})
