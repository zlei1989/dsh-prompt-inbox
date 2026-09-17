/**
 * 元素快照的进程内激活集。
 *
 * 回弹某条草稿时把它的元素快照载入这里，系统提示上下文段与
 * prompt_inbox_element 工具都从这里读。同一时刻只有一组激活元素——
 * composer 同一时刻也只装得下一条草稿，多组并存只会让 [DOMn] 指向歧义。
 */

import type { DraftElementRecord } from '../shared/types.ts'

/** 激活集接口。 */
export interface ElementRegistry {
  /** 用一条草稿的元素快照替换当前激活集。 */
  activate(records: DraftElementRecord[], sourceLabel: string): void
  /** 当前激活元素，按激活时顺序。 */
  list(): DraftElementRecord[]
  /** 按编号查询。 */
  find(id: string): DraftElementRecord | undefined
  /**
   * 清空激活集：输入框被清空/发送后调用。
   *
   * 唯一的生产调用点是 `/invoke` 的 `draft-set-active { id: null }`（见 routes.ts）——
   * 它与清除 `active` 标志是同一次调用，好让「当前草稿」与激活集永远同生共死。
   */
  clear(): void
  /** 这批元素来自哪条草稿，用于提示段措辞。 */
  sourceLabel(): string
}

/** 创建激活集。 */
export function createElementRegistry(): ElementRegistry {
  let records: DraftElementRecord[] = []
  let label = ''

  return {
    activate(next: DraftElementRecord[], sourceLabel: string): void {
      // 同 id 去重，保留先出现的（保持草稿内原始顺序与语义）
      const seen = new Set<string>()
      const deduped: DraftElementRecord[] = []
      for (const record of next) {
        if (seen.has(record.id)) continue
        seen.add(record.id)
        deduped.push(record)
      }
      records = deduped
      label = sourceLabel
    },

    list(): DraftElementRecord[] {
      return records
    },

    find(id: string): DraftElementRecord | undefined {
      return records.find((record) => record.id === id)
    },

    clear(): void {
      records = []
      label = ''
    },

    sourceLabel(): string {
      return label
    },
  }
}
