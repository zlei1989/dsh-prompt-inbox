/**
 * 草稿箱的 HTTP 面：`/invoke` 业务分发 + `/asset` 资产字节读取。
 *
 * host 与 client 运行在不同程序里（Node 进程与浏览器页面），只能经 harness
 * webserver 的同源路由交换 JSON——这是本插件唯一的网络面。
 *
 * 两条路由的响应约定不同，别把它们的规则混在一起：
 *   - `/invoke`：**永远回 200 + `{ ok }` 信封**。业务失败也走 `ok:false`，
 *     调用方只看信封字段、不看状态码；只有传输层形状错误（body 超限、
 *     HTTP 方法不对）才回非 200。
 *   - `/asset`：成功直接回字节（`application/octet-stream`），失败回 JSON 错误。
 *
 * 安全边界：`/asset` 的 `ref` 必须命中「sha256/<2 位 hex>/<64 位 hex>.bin」
 * 白名单形状。**这是防路径穿越的唯一防线**——`refToPath` 走
 * `join(root, ...ref.split('/'))`，`..` 会被 join 正常归一化，也就是说
 * `join` 那一层从来挡不住任何东西；唯一的校验就是这里，而且必须在触碰
 * `assets.read` **之前**完成（见本文件的 handleAsset 与它对应的测试）。
 */

import type { AssetStore } from './asset-store.ts'
import type { DraftService } from './draft-service.ts'
import type { ElementRegistry } from './element-registry.ts'
import type { WebRequestLike, WebResponseLike, WebServerFace } from './services.ts'
import type { DraftElementRecord, DraftSavePayload, InvokeResult } from '../shared/types.ts'

/** `/invoke` 的方法处理器：入参是信封里的 params，返回同一个信封。 */
export type InvokeHandler = (params: Record<string, unknown>) => Promise<InvokeResult>

/** 路由层用到的日志表面（与 host 半 log* 系列同形，便于直接传进去）。 */
export interface RouteLogger {
  debug(msg: string): void
  info(msg: string): void
  warn(msg: string): void
  error(msg: string, err?: unknown): void
}

/** 插件 id：两条路由的公共前缀。 */
const PLUGIN_ID = 'dsh-prompt-inbox'

/**
 * 资产字节读取路由。
 *
 * `draft-get` 返回的 assetUrls 也用这个常量拼，所以只在这里定义一次：
 * 两处一旦不一致，客户端拿到的 URL 会指向一条不存在的路由。
 */
export const ASSET_PATH = '/' + PLUGIN_ID + '/asset'

/**
 * 合法资产 ref 的形状：`sha256/<sha256 前 2 位>/<64 位小写 hex>.bin`。
 *
 * 严格程度与 `shardRef` 的产出完全一致（小写 hex、定长、恒用 `/`），
 * 所以 `put()` 的返回值永远能通过，而 `../`、绝对路径、盘符、URL 编码等
 * 一律过不了。校验先于 `assets.read`——顺序见 handleAsset 的注释。
 */
const ASSET_REF_PATTERN = /^sha256\/[0-9a-f]{2}\/[0-9a-f]{64}\.bin$/

/**
 * 把元素快照放进信封的 `records` 字段。
 *
 * 信封里 `records` 的声明类型是 `DraftRecord[]`（`draft-list` 的载荷，客户端
 * 也按草稿数组消费它），而 `element-list` 按 spec 复用同一个字段装
 * `DraftElementRecord[]`——两者都是 JSON 数组，靠 method 名区分。
 *
 * 这里做一次显式转换而不是把共享类型放宽成联合：放宽之后客户端每次读草稿
 * 列表都得先窄化一次，为了一个只在 host 内部出现的差异去污染跨端契约不值得。
 */
function asRecords(records: DraftElementRecord[]): NonNullable<InvokeResult['records']> {
  return records as unknown as NonNullable<InvokeResult['records']>
}

/**
 * 构造 `/invoke` 的方法表。
 *
 * @param deps.service - 草稿领域服务（保存/列出/取回/删除/置 active）。
 * @param deps.assets - 资产存储。方法表本身不读字节（`/asset` 路由负责），
 *   保留在依赖里是因为 HTTP 面的两半必须共用同一个 store：装配方拿这一份
 *   依赖同时构造方法表与字节路由，避免出现「记录写了 A 目录、字节读 B 目录」。
 *   更要紧的是**这个参数必须留着**：签名与测试 harness 都由任务契约固定
 *   （harness 会传 `assets` 这个键），删掉它会同时破坏契约与所有调用方，
 *   所以即便函数体暂时用不到它，也是有意保留、不是可以顺手清理的死参数。
 * @param deps.registry - 元素激活集，回弹草稿时载入。
 */
export function createHandlers(deps: {
  service: DraftService
  assets: AssetStore
  registry: ElementRegistry
}): Map<string, InvokeHandler> {
  const { service, registry } = deps
  const handlers = new Map<string, InvokeHandler>()

  // 保存：payload 由 client 现场采集（正文 + 附件字节 + 元素编号）
  handlers.set('draft-save', async (params) => {
    const payload = params.payload
    if (typeof payload !== 'object' || payload === null) {
      return { ok: false, error: '缺少 payload' }
    }
    try {
      // service.save 是异步的（落资产、查 picker 摘要都是异步）：漏掉 await
      // 会把 Promise 当成记录序列化出去，客户端只会拿到一个空对象
      const { record, warnings } = await service.save(payload as DraftSavePayload)
      return { ok: true, record, warnings }
    } catch (err) {
      // 超整次上限等业务失败：走 ok:false，HTTP 仍是 200
      return { ok: false, error: String((err as Error)?.message || err) }
    }
  })

  handlers.set('draft-list', async () => ({ ok: true, records: service.list() }))

  // 取一条用于回弹：附带每个附件的读取 URL，并把元素快照载入激活集
  handlers.set('draft-get', async (params) => {
    const id = String(params.id ?? '')
    const record = service.get(id)
    if (record === undefined) return { ok: false, error: '未找到草稿 ' + id }
    // 回弹的副作用：草稿自带的 [DOMn] 指向的正是这批快照，激活它之后
    // 系统提示段与 prompt_inbox_element 工具才解释得通正文里的记号
    registry.activate(record.content.elements, '草稿 ' + id)
    const assetUrls: Record<string, string> = {}
    for (const attachment of record.content.attachments) {
      if (attachment.asset === undefined) continue
      assetUrls[attachment.asset.ref] = ASSET_PATH + '?ref=' + encodeURIComponent(attachment.asset.ref)
    }
    return { ok: true, record, assetUrls }
  })

  handlers.set('draft-remove', async (params) => {
    const id = String(params.id ?? '')
    const { removed, reclaimed } = service.remove(id)
    if (!removed) return { ok: false, error: '未找到草稿 ' + id }
    return { ok: true, reclaimed }
  })

  // 置 active：null 表示「输入框已清空」，把所有记录的标志一起清掉。
  // 「哪些记录真的变了、只写回变化的那些」由 service.setActive 负责，这里不重做一遍。
  //
  // `id === null` 时**连带清空元素激活集**：两者是同一条不变量的两半。
  // 提示段那句「用户消息中的 [DOMn] 与下列编号一一对应」成立的前提是 composer 里
  // 正装着那条草稿的正文；composer 一空，这句话就是假的（草稿甚至可能已被删除），
  // 而模型会拿这批旧编号去解释新正文。只清 active 不清激活集，等于把激活集留成
  // 一个再也没有主人的进程级残留——所以这里必须让两者一起消失。
  handlers.set('draft-set-active', async (params) => {
    const id = typeof params.id === 'string' && params.id !== '' ? params.id : null
    service.setActive(id)
    if (id === null) registry.clear()
    return { ok: true }
  })

  handlers.set('element-list', async () => ({ ok: true, records: asRecords(registry.list()) }))

  return handlers
}

/**
 * 注册 `/invoke`（POST）与 `/asset`（GET）两条路由。
 *
 * @param options.webServer - harness web 服务器。
 * @param options.path - `/invoke` 的绝对路径。
 * @param options.handlers - `createHandlers` 产出的方法表。
 * @param options.assets - 资产存储：`/asset` 按 ref 读字节。`createHandlers`
 *   的签名里没有路由参数，字节路由又必须拿到 store，所以它从这里传入。
 * @param options.maxBodyBytes - 请求体上限（由装配方按草稿上限算出）。
 * @param options.log - 日志回调。
 * @returns 撤销两条路由的清理器（供 ctx.effect 登记）。
 */
export function registerInvokeRoute(options: {
  webServer: WebServerFace
  path: string
  handlers: Map<string, InvokeHandler>
  assets: AssetStore
  maxBodyBytes: number
  log: RouteLogger
}): () => void {
  const { webServer, path, handlers, assets, maxBodyBytes, log } = options

  const disposeInvoke = webServer.register({
    kind: 'exact',
    path,
    handler: (req, res) => {
      handleInvoke(req, res, handlers, maxBodyBytes, log)
    },
  })

  try {
    const disposeAsset = webServer.register({
      kind: 'exact',
      path: ASSET_PATH,
      handler: (req, res) => {
        handleAsset(req, res, assets, log)
      },
    })
    return () => {
      disposeAsset()
      disposeInvoke()
    }
  } catch (err) {
    // 第二条注册失败（同一进程里重复加载本插件）：先撤掉第一条，
    // 否则会留下「invoke 在、asset 不在」的半套网络面，比整套都没有更难查
    disposeInvoke()
    throw err
  }
}

/**
 * `/invoke` 的路由处理器：收 body → 按 method 分发 → 回 JSON 信封。
 *
 * @param req - Node 风格请求；只用到 data/end 两个事件。
 * @param res - Node 风格响应。
 * @param handlers - 方法表。
 * @param maxBodyBytes - 请求体上限，单位是**字节**（不是码元）；超过即回 413 并停止解析。
 * @param log - 日志回调。
 */
function handleInvoke(
  req: WebRequestLike,
  res: WebResponseLike,
  handlers: Map<string, InvokeHandler>,
  maxBodyBytes: number,
  log: RouteLogger,
): void {
  // 传输层形状错误：这条路由只收 POST（客户端固定用 POST + JSON 信封）
  if (req.method !== undefined && req.method !== 'POST') {
    respondJson(res, 405, { ok: false, error: '只支持 POST' }, log)
    return
  }

  // 请求体按**原始字节**累积，直到 end 才一次性解码。绝不能逐 chunk 写
  // `body += String(chunk)`：socket 的分块边界与字符边界无关，一个汉字（3 字节）
  // 被切开时，两半分别解码会各自变成 U+FFFD——而正文正是本产品的载荷
  // （中文提示词），那是保存时的静默数据损坏。字节数组里拼回去再解码，
  // 被切开的字符就能完整还原。
  const chunks: Buffer[] = []
  let receivedBytes = 0
  let overflow = false
  // 响应已写出标记。注意：Node 在请求体读完时就会触发 `close`，早于异步处理
  // 完成，所以不能用 close 判断对端断开；回包统一走 respond()。
  let sent = false

  /**
   * 幂等回包：第一次调用生效，之后静默忽略。
   * 客户端可能已提前断开，此时 writeHead/end 会抛错——降级为 DEBUG，
   * 因为对端已经没人接这个响应，不值得污染 WARN/ERROR。
   */
  const respond = (status: number, payload: unknown): void => {
    if (sent) return
    sent = true
    try {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(payload))
    } catch (err) {
      log.debug('响应写出失败（客户端可能已断开）: ' + String((err as Error)?.message || err))
    }
    log.debug('invoke 响应已写出: status=' + status)
  }

  req.on('data', (chunk) => {
    // 超限后继续吃掉剩余 body 而不是摘掉监听：请求体没人读会让连接悬着
    if (overflow) return
    const bytes = chunk as Buffer
    chunks.push(bytes)
    // 按**字节**量上限。不能用 body.length 或 chunk.length：`String.length` 数的是
    // UTF-16 码元，一个汉字只算 1，而它在线上占 3 字节，中文正文会被少算到 1/3；
    // 更别说 chunk 此刻还只是字节、根本没解码。不回 200 而回 413，是因为
    // 「body 太大」属于传输层问题，不是信封能表达的业务失败。
    receivedBytes += bytes.byteLength
    if (receivedBytes > maxBodyBytes) {
      overflow = true
      log.warn('请求体超过 ' + maxBodyBytes + ' 字节，已回 413')
      respond(413, { ok: false, error: '请求体过大' })
    }
  })

  req.on('end', () => {
    if (overflow) return
    // 解码只在这里发生一次：Buffer.concat 先把被切开的字节拼回完整序列，
    // 所以跨越 chunk 边界的多字节字符不会变成 U+FFFD
    const body = Buffer.concat(chunks).toString('utf8')
    void (async () => {
      let method = ''
      try {
        const parsed = JSON.parse(body || '{}') as { method?: unknown; params?: unknown }
        method = String(parsed.method || '')
        const handler = handlers.get(method)
        if (handler === undefined) throw new Error('未知方法 ' + (method || '(空)'))
        const rawParams: unknown = parsed.params
        const params: Record<string, unknown> = (rawParams !== null && typeof rawParams === 'object')
          ? rawParams as Record<string, unknown>
          : {}
        log.debug('invoke 入口: ' + method)
        const result = await handler(params)
        respond(200, result)
      } catch (err) {
        // 业务失败也回 200 + ok:false：HTTP 状态码语义留给传输层，调用方只看信封
        log.error('invoke 失败: ' + (method || '(解析失败)'), err)
        respond(200, { ok: false, error: String((err as Error)?.message || err) })
      }
    })()
  })
}

/**
 * `/asset` 的路由处理器：按 ref 回资产字节。
 *
 * **校验顺序就是安全边界**：先按白名单形状校验 ref，再碰 `assets.read`。
 * 反过来写（先读、读不到/读到不该读的再判形状）会让 `../../` 这类 ref
 * 真的落到文件系统调用上——那条路径上 `join` 会老老实实把它归一化出去。
 *
 * @param req - 只收 GET；ref 经 query 传入（客户端 `encodeURIComponent` 过）。
 * @param res - 成功回字节，失败回 JSON 错误。
 * @param assets - 资产存储。
 * @param log - 日志回调。
 */
function handleAsset(req: WebRequestLike, res: WebResponseLike, assets: AssetStore, log: RouteLogger): void {
  if (req.method !== undefined && req.method !== 'GET') {
    respondJson(res, 405, { ok: false, error: '只支持 GET' }, log)
    return
  }

  let ref = ''
  try {
    ref = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('ref') ?? ''
  } catch (err) {
    log.warn('资产路由收到无法解析的 URL: ' + String((err as Error)?.message || err))
    respondJson(res, 400, { ok: false, error: '资产引用不合法' }, log)
    return
  }

  // 顺序不可交换：这一行必须早于下面的 assets.read
  if (!ASSET_REF_PATTERN.test(ref)) {
    // WARN 而非 DEBUG：不合形状的 ref 只可能来自客户端 bug 或有人在探测路径穿越
    log.warn('资产路由拒绝不合白名单形状的 ref: ' + JSON.stringify(ref))
    respondJson(res, 400, { ok: false, error: '资产引用不合法' }, log)
    return
  }

  let bytes: Uint8Array
  try {
    bytes = assets.read(ref)
  } catch (err) {
    // 形状合法但文件不在（例如被外部删掉）：404，让客户端把该附件降级
    log.warn('资产读取失败: ' + ref + '（' + String((err as Error)?.message || err) + '）')
    respondJson(res, 404, { ok: false, error: '资产不存在' }, log)
    return
  }

  try {
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(bytes.byteLength),
    })
    res.end(bytes)
    log.debug('资产已写出: ' + ref + '（' + bytes.byteLength + ' 字节）')
  } catch (err) {
    log.debug('资产响应写出失败（客户端可能已断开）: ' + String((err as Error)?.message || err))
  }
}

/** 回一个 JSON 响应；对端已断开时降级为 DEBUG（同 handleInvoke 的 respond）。 */
function respondJson(res: WebResponseLike, status: number, payload: unknown, log: RouteLogger): void {
  try {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(payload))
  } catch (err) {
    log.debug('响应写出失败（客户端可能已断开）: ' + String((err as Error)?.message || err))
  }
}
