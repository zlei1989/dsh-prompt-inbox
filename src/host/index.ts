/**
 * dsh-prompt-inbox — Host 半边（已安装包入口）。
 *
 * 一个普通的 Cordis 插件模块（ESM），由 profile loader 作为
 * `dsh-prompt-inbox` 行加载。它贡献三件事：
 *   - `/dsh-prompt-inbox/invoke` HTTP 路由：浏览器 UI 的同源调用入口
 *     （ctx.webServer）
 *   - `/dsh-prompt-inbox/asset` HTTP 路由：按 ref 读附件字节（同源取字节流）
 *   - 模型面：`prompt_inbox_element` 工具与 `prompt-inbox` 系统提示上下文段
 *     （ctx.tools / ctx.systemPrompt），两者读的是同一个元素激活集——回弹草稿时
 *     由 `/invoke` 的 `draft-get` 载入，模型因此能把正文里的 [DOMn] 问明白
 *
 * 模块级 `inject` 是唯一的门控：Cordis 会让此插件保持挂起，直到三个
 * provider 全部激活。若省略 inject，`apply` 会在 profile 加载时与服务
 * 纤程竞态，`ctx.get(...)` 可能返回 undefined。
 *
 * 切勿添加 `export default apply`：Loader 的 unwrapExports（`exports.default ?? exports`）
 * 会把模块坍缩成裸函数并丢掉 inject。
 *
 * 配置（可选，来自 bundle 行的 config，全部有默认值，见 spec §3.5）：
 * `maxAttachmentBytes` / `maxDraftBytes` / `maxRecords` / `logPath` / `assetsDir`。
 * 这里没有 schemastery schema 可挂——host 半不许引 npm 运行时依赖，而 schema
 * 来自 npm 包；已核实 Cordis 的 `resolveConfig` 在插件没有 `Config` 导出时
 * 会把行 config **原样**交给 apply 的第二个参数，所以本文件自己做等价校验：
 * 缺失用默认值，非法值告警后退回默认值。
 *
 * 日志：统一走本文件的 log* 系列（带插件前缀）；DEBUG 级生产默认关闭，
 * 设 `DSH_PROMPT_INBOX_DEBUG=1` 打开。
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SystemPromptFace, ToolsFace, WebServerFace } from './services.ts'
import { createAssetStore } from './asset-store.ts'
import { createDraftService } from './draft-service.ts'
import { createDraftStore, DEFAULT_RECORDS } from './draft-store.ts'
import { createElementRegistry } from './element-registry.ts'
import { createPickerElementSource } from './element-source.ts'
import { resolveDshHome } from './home.ts'
import { ASSET_PATH, createHandlers, registerInvokeRoute } from './routes.ts'
import type { RouteLogger } from './routes.ts'
import {
  buildPromptSection,
  PROMPT_INBOX_SECTION_NAME,
  PROMPT_INBOX_TOOL_NAME,
  registerPromptInboxTools,
} from './tools.ts'

export const name = 'dsh-prompt-inbox'

/** 必需服务：Cordis 会保持本纤程挂起，直到全部服务激活。 */
export const inject = ['tools', 'systemPrompt', 'webServer']

/** 插件 id：同时用于路由前缀与 client 槽位 id，必须保持一致。 */
const PLUGIN_ID = 'dsh-prompt-inbox'
/** 浏览器 UI 的同源调用入口。 */
const INVOKE_PATH = '/dsh-prompt-inbox/invoke'
/** 单附件默认上限：20MB。 */
const DEFAULT_MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
/** 单草稿默认上限：50MB。 */
const DEFAULT_MAX_DRAFT_BYTES = 50 * 1024 * 1024
/** 请求体上限在草稿上限之外额外留出的余量：JSON 信封本身的字节。 */
const BODY_ENVELOPE_BYTES = 1024 * 1024

/**
 * 元素快照提示上下文段的排序位。
 *
 * `systemPrompt.context` 的 order 与 `systemPrompt.section` 的 order 是**两个互不
 * 相干的排序空间**：本值只跟运行时上下文快照内部的其它条目比较。已核实 harness
 * 的集中排序表（`getContextOrder`）只覆盖三个内置条目——SANDBOX_POLICY=110、
 * APPROVAL_POLICY=115、SUBAGENT_DELEGATION=120——树外插件按约定自行给整数。
 * 取 130：排在三个内置事实之后，模型先读到沙箱/审批这类运行时事实，再看这批
 * [DOMn] 指向什么。本段为空时 `text()` 回空串，组装时整条快照不计入上下文。
 */
const CONTEXT_ORDER = 130

/**
 * 插件配置：全部可选，未设置时用默认值。
 * 键名与 spec §3.5 的表一致；用户在 profile 的 `cordis.patch.yml` 里按行 id 覆盖。
 */
export interface Config {
  /** 单附件字节上限，超过则该附件降级为只存元信息。 @default 20971520 */
  maxAttachmentBytes?: number
  /** 单草稿字节上限，超过则整次保存失败（不做部分成功）。 @default 52428800 */
  maxDraftBytes?: number
  /** jsonl 行数上限，超过即压紧。 @default 500 */
  maxRecords?: number
  /** 草稿变更日志路径。 @default $DSH_HOME/prompt-inbox.jsonl */
  logPath?: string
  /** 附件旁路资产目录。 @default $DSH_HOME/prompt-inbox-assets */
  assetsDir?: string
}

/** 日志统一前缀（便于在 harness 日志流中检索本插件条目）。 */
const LOG_PREFIX = '[' + PLUGIN_ID + ']'
/** DEBUG 开关：生产默认关闭，环境变量 `DSH_PROMPT_INBOX_DEBUG=1` 打开。 */
const DEBUG_ENABLED = typeof process !== 'undefined' && !!(process.env && process.env.DSH_PROMPT_INBOX_DEBUG)

/** DEBUG：分支走向、中间变量、循环关键节点（生产默认关闭）。 */
function logDebug(msg: string): void {
  if (DEBUG_ENABLED) console.debug(LOG_PREFIX + ' [DEBUG] ' + msg)
}
/** INFO：请求入口、关键状态变更、外部调用耗时。 */
function logInfo(msg: string): void {
  console.info(LOG_PREFIX + ' [INFO] ' + msg)
}
/** WARN：降级、重试、超时、可选服务缺失但可继续。 */
function logWarn(msg: string): void {
  console.warn(LOG_PREFIX + ' [WARN] ' + msg)
}
/** ERROR：业务异常、外部调用失败——必须带堆栈和业务上下文。 */
function logError(msg: string, err?: unknown): void {
  const e = err as Error | null | undefined
  const detail = e && e.stack ? e.stack : String((e && e.message) || err || '')
  console.error(LOG_PREFIX + ' [ERROR] ' + msg + (detail ? '\n' + detail : ''))
}

/** 路由层日志：复用同一套 log* 系列（前缀与 DEBUG 门控一并继承）。 */
const routeLogger: RouteLogger = { debug: logDebug, info: logInfo, warn: logWarn, error: logError }

/**
 * 取正整数配置。
 * 非法值（非数字、非整数、<=0）只告警并退回默认值：一个写错的配置不该让
 * 整个插件纤程启动失败，草稿库可用性优先。
 */
function pickPositiveInt(value: unknown, fallback: number, key: string): number {
  if (value === undefined) return fallback
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value
  logWarn('配置 ' + key + ' 非法（' + String(value) + '），改用默认值 ' + fallback)
  return fallback
}

/** 取路径配置：非空字符串才采用，否则退回默认值（空串会让日志写到当前目录）。 */
function pickPath(value: unknown, fallback: string, key: string): string {
  if (typeof value === 'string' && value.trim() !== '') return value
  if (value !== undefined) logWarn('配置 ' + key + ' 非法（' + String(value) + '），改用默认值 ' + fallback)
  return fallback
}

export function apply(ctx: Context, config: Config = {}): void {
  const webServer = ctx.get('webServer') as WebServerFace

  // ---- 配置解析（全部有默认值） ------------------------------------------

  const home = resolveDshHome()
  const logPath = pickPath(config.logPath, join(home, 'prompt-inbox.jsonl'), 'logPath')
  const assetsDir = pickPath(config.assetsDir, join(home, 'prompt-inbox-assets'), 'assetsDir')
  const maxAttachmentBytes = pickPositiveInt(config.maxAttachmentBytes, DEFAULT_MAX_ATTACHMENT_BYTES, 'maxAttachmentBytes')
  const maxDraftBytes = pickPositiveInt(config.maxDraftBytes, DEFAULT_MAX_DRAFT_BYTES, 'maxDraftBytes')
  const maxRecords = pickPositiveInt(config.maxRecords, DEFAULT_RECORDS, 'maxRecords')

  // 传输层上限必须比业务上限宽：body 里装的是 base64（约为原始字节的 4/3）
  // 加 JSON 信封。若把这里定成一个与草稿上限无关的常量，20MB 的合法附件会
  // 先被 413 挡掉，用户永远看不到「整次超限」那条业务提示。
  const maxBodyBytes = Math.ceil(maxDraftBytes / 3 * 4) + BODY_ENVELOPE_BYTES

  // ---- 领域装配 ----------------------------------------------------------

  // maxRecords 由服务侧执行压紧（store 只是留了这个接口位）；两边传同一个值
  const store = createDraftStore({ logPath, maxRecords, onWarn: logWarn })
  const assets = createAssetStore({ root: assetsDir, onWarn: logWarn })
  // 元素摘要要回到 harness 自己的 webserver 上取：picker 只暴露 HTTP 面
  const elements = createPickerElementSource({
    baseUrl: 'http://127.0.0.1:' + webServer.port,
    onWarn: logWarn,
  })
  const registry = createElementRegistry()
  const service = createDraftService({
    store,
    assets,
    elements,
    maxAttachmentBytes,
    maxDraftBytes,
    maxRecords,
    onWarn: logWarn,
  })

  // ---- 启动期孤儿资产清扫 ------------------------------------------------

  // assets.collectGarbage 的生产调用点原本只有 draft-service.remove()，于是
  // 「整次超限」失败时已经落盘的字节要等到用户删掉某条草稿才可能被回收——用户
  // 不删就永远留着。这里在装配阶段扫一次，成本是一次目录遍历。
  // 失败只告警：草稿库可用性远比几个孤儿字节重要，清扫绝不能拖垮插件激活。
  try {
    const reclaimed = assets.collectGarbage(service.referencedAssetRefs())
    if (reclaimed > 0) logInfo('启动清扫回收了 ' + reclaimed + ' 个孤儿资产文件')
  } catch (err) {
    logWarn('启动期孤儿资产清扫失败（不影响草稿功能）: ' + String((err as Error)?.message || err))
  }

  // ---- 浏览器 UI 调用面 --------------------------------------------------

  /** `/invoke` 支持的方法表：client 半按 method 名分发到这里的处理器。 */
  const handlers = createHandlers({ service, assets, registry })

  // 注册 HTTP 路由：client 半以同源 fetch POST { method, params } 调用；
  // 路由注册返回清理器，交给 ctx.effect 以便卸载时撤销。
  ctx.effect(() => {
    try {
      return registerInvokeRoute({ webServer, path: INVOKE_PATH, handlers, assets, maxBodyBytes, log: routeLogger })
    } catch (err) {
      // 路由冲突（同一进程内重复加载本插件）不应让整个插件纤程失败
      logError('HTTP 路由注册失败（浏览器 UI 将无法调用 host）', err)
      return () => {}
    }
  })

  // ---- 模型面（工具 + 系统提示上下文段） ----------------------------------

  // 两个服务由模块级 inject 保证在场（Cordis 会让本纤程等到它们激活），
  // 取到即用于注册，不留未使用的绑定。两者读同一个 registry，所以回弹草稿后
  // 「提示段列出的编号」与「工具查得到的编号」必然一致。
  const tools = ctx.get('tools') as ToolsFace
  const systemPrompt = ctx.get('systemPrompt') as SystemPromptFace

  ctx.effect(() => {
    try {
      return registerPromptInboxTools({ tools, registry })
    } catch (err) {
      // 工具名冲突（重复加载）或注册表拒绝：草稿库本身照常可用，不该整插件失败
      logError('工具注册失败（模型将无法按编号查询草稿元素）', err)
      return () => {}
    }
  })

  ctx.effect(() => {
    try {
      return systemPrompt.context({
        name: PROMPT_INBOX_SECTION_NAME,
        order: CONTEXT_ORDER,
        text: () => buildPromptSection(registry),
      })
    } catch (err) {
      // 段名冲突（重复加载）：没有这一段，模型只是不知道有哪些 [DOMn] 可查
      logError('系统提示上下文段注册失败（模型不会知道有哪些 [DOMn] 可查）', err)
      return () => {}
    }
  })

  logDebug('模型面已注册：工具 ' + PROMPT_INBOX_TOOL_NAME + ' 与提示段 '
    + PROMPT_INBOX_SECTION_NAME + '（order=' + CONTEXT_ORDER + '）')

  logInfo('host 半已加载（路由 ' + INVOKE_PATH + ' 与 ' + ASSET_PATH + '，日志 ' + logPath + '）')
}
