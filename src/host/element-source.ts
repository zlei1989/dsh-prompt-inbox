/**
 * 元素来源适配层。
 *
 * 已核实的能力边界（见 spec §3.4）：dsh-webpage-element-picker 把完整 payload
 * 放在自己的 host 进程内存里，`/invoke` 只暴露 picker-context-list，返回类型
 * ContextItemSummary 只有 { domId, label, pageUrl }，源码注释明确写着「不含大 payload」。
 *
 * 所以在「不改 DSH 源码、不改其他插件」的约束下，本插件只能拿到摘要。
 * 设计上把这条硬边界收进一个接口：默认实现走 picker-context-list，
 * 未来对端若暴露按编号取 payload 的方法，只需再加一个实现。
 *
 * 关键取舍：任何失败都降级为「只留 id」，绝不抛错、绝不伪造字段——
 * 保存草稿不应该因为 picker 没开而整个失败。
 */

import type { DraftElementRecord } from '../shared/types.ts'

/** 按编号查询元素信息的来源。 */
export interface ElementSource {
  /**
   * 查询一批元素编号。
   * @param ids - 形如 DOM1、DOM2 的编号。
   * @returns 与 ids 顺序一致的记录；查不到的项只填 id 并标 degraded。
   */
  lookup(ids: string[]): Promise<DraftElementRecord[]>
}

/** picker 的摘要条目形状（对应其 ContextItemSummary，只取用到的字段）。 */
interface PickerSummaryItem {
  domId?: unknown
  label?: unknown
  pageUrl?: unknown
}

/**
 * 创建基于 picker-context-list 的元素来源。
 * @param options.baseUrl - harness webserver 的 origin，如 `http://127.0.0.1:3080`。
 * @param options.invokePath - picker 的调用路径，默认其历史默认值。
 * @param options.fetchImpl - 可注入的 fetch，测试用。
 * @param options.onWarn - 降级原因的回调，交给调用方记日志。
 */
export function createPickerElementSource(options: {
  baseUrl: string
  invokePath?: string
  fetchImpl?: typeof fetch
  onWarn?: (msg: string) => void
}): ElementSource {
  const invokePath = options.invokePath ?? '/dsh-webpage-element-picker/invoke'
  const doFetch = options.fetchImpl ?? fetch

  /** 拉一次摘要表；任何异常都视为「没有摘要」。 */
  const fetchSummaries = async (): Promise<Map<string, { label?: string; pageUrl?: string }>> => {
    try {
      const res = await doFetch(options.baseUrl + invokePath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'picker-context-list', params: {} }),
      })
      if (!res.ok) {
        options.onWarn?.('picker 摘要请求返回 HTTP ' + res.status + '，元素降级为仅编号')
        return new Map()
      }
      const body = (await res.json()) as { ok?: unknown; items?: unknown }
      if (body.ok !== true || !Array.isArray(body.items)) {
        options.onWarn?.('picker 未返回可用摘要（可能未装或未打开浏览器），元素降级为仅编号')
        return new Map()
      }
      const map = new Map<string, { label?: string; pageUrl?: string }>()
      for (const raw of body.items as PickerSummaryItem[]) {
        if (typeof raw.domId !== 'string') continue
        map.set(raw.domId, {
          ...(typeof raw.label === 'string' && raw.label !== '' ? { label: raw.label } : {}),
          ...(typeof raw.pageUrl === 'string' && raw.pageUrl !== '' ? { pageUrl: raw.pageUrl } : {}),
        })
      }
      return map
    } catch (err) {
      options.onWarn?.('picker 摘要请求失败（' + String((err as Error)?.message || err) + '），元素降级为仅编号')
      return new Map()
    }
  }

  return {
    async lookup(ids: string[]): Promise<DraftElementRecord[]> {
      if (ids.length === 0) return []
      const summaries = await fetchSummaries()
      return ids.map((id) => {
        const hit = summaries.get(id)
        // payload 恒为 null：当前边界下拿不到，标 degraded 让 UI 与模型都知道这是摘要
        return {
          id,
          ...(hit?.label !== undefined ? { label: hit.label } : {}),
          ...(hit?.pageUrl !== undefined ? { pageUrl: hit.pageUrl } : {}),
          payload: null,
          degraded: true,
        }
      })
    },
  }
}
