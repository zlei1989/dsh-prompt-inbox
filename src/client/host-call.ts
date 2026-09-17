/**
 * client 半的公共底座：插件 id、日志、`/invoke` 调用与资产 URL。
 *
 * 这几件东西每个 client 组件都要用（保存按钮、草稿 tab、回弹动作），原先散在
 * `index.ts` 里且只有一个调用方；收在这里之后 `index.ts` 只负责装配。
 * 依赖方向是单向的：本文件不认识 React，也不认识任何组件。
 */

import type { InvokeResult } from '../shared/types.ts'

/** 插件 id：样式标签、日志前缀、`/invoke` 路由前缀共用一份。 */
export const PLUGIN_ID = 'dsh-prompt-inbox'

/** host 半 `/invoke` 的绝对路径。 */
export const INVOKE_PATH = '/' + PLUGIN_ID + '/invoke'

/** 资产字节路由的绝对路径（host 侧 `ASSET_PATH` 的同值镜像）。 */
export const ASSET_PATH = '/' + PLUGIN_ID + '/asset'

/** 日志统一前缀（DevTools 控制台检索用）。 */
const LOG_PREFIX = '[' + PLUGIN_ID + ']'

/** DEBUG：分支走向、中间变量（console.debug，默认级别不可见）。 */
export function logDebug(msg: string): void {
  console.debug(LOG_PREFIX + ' [DEBUG] ' + msg)
}

/** INFO：请求入口、关键状态变更、外部调用耗时 >500ms。 */
export function logInfo(msg: string): void {
  console.info(LOG_PREFIX + ' [INFO] ' + msg)
}

/** ERROR：业务异常、外部调用失败——带堆栈和业务上下文。 */
export function logError(msg: string, err?: unknown): void {
  const e = err as Error | null | undefined
  const detail = e && e.stack ? e.stack : String((e && e.message) || err || '')
  console.error(LOG_PREFIX + ' [ERROR] ' + msg + (detail ? '\n' + detail : ''))
}

/**
 * 调用 host 半的 `/invoke` 路由。
 * 同源 POST：web shell 与插件 API 同 origin；耗时 >500ms 记 INFO。
 *
 * @param method - host 方法表里的方法名。
 * @param params - 方法参数（缺省为空对象）。
 * @returns 统一信封；HTTP 非 2xx 直接抛错（业务失败走 `ok:false`，HTTP 仍是 200）。
 */
export function hostCall(method: string, params?: Record<string, unknown>): Promise<InvokeResult> {
  const base = typeof window !== 'undefined' && window.location ? window.location.origin : ''
  const startedAt = Date.now()
  logDebug('host 调用: ' + method + ' 参数: ' + JSON.stringify(params || {}))
  return fetch(base + INVOKE_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, params: params || {} }),
  }).then((res) => {
    if (!res.ok) throw new Error('HTTP ' + res.status)
    return res.json() as Promise<InvokeResult>
  }).then((value) => {
    const cost = Date.now() - startedAt
    if (cost > 500) logInfo('host 调用 ' + method + ' 耗时 ' + cost + 'ms')
    return value
  })
}

/**
 * 按资产 ref 拼字节路由 URL（GET `/dsh-prompt-inbox/asset?ref=<encoded ref>`）。
 *
 * `draft-get` 返回的 `assetUrls[ref]` 已经是**带查询串的完整路径**，回弹时优先
 * 用它（见 composer-bridge）；本函数是「拿不到 assetUrls」时的兜底。
 */
export function assetUrl(ref: string): string {
  return ASSET_PATH + '?ref=' + encodeURIComponent(ref)
}
