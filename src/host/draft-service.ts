/**
 * 草稿领域服务：把 client 提交的保存载荷变成一条可落盘的草稿记录。
 *
 * 职责边界：只做「校验 + 提取 + 落资产 + 落记录 + 回收」，
 * 不碰 HTTP、不碰系统提示、不碰工具注册——那些由 routes.ts / tools.ts 负责。
 *
 * 关键不变量：**记录绝不指向不存在的资产**。所以顺序必须是
 * 「先落资产、再追加记录」；反过来（先记录后资产）会留下悬空引用。
 * 若资产落盘成功而记录追加失败，留下的只是孤儿资产，由 GC 清掉，不产生坏草稿。
 */

import type { AssetStore } from './asset-store.ts'
import type { DraftStore } from './draft-store.ts'
import type { ElementSource } from './element-source.ts'
import type {
  DraftAttachmentRecord,
  DraftRecord,
  DraftSavePayload,
} from '../shared/types.ts'

/** 正文里 [DOMn] 占位符的扫描式：与 picker 的占位符约定一致。 */
const ELEMENT_TOKEN = /\[(DOM\d+)\]/g

/**
 * 提取正文里出现的元素编号，按首次出现顺序去重。
 * 只认 picker 使用的 [DOMn] 形式——这样新会话里模型看到的记号
 * 与它已经学会的完全一样，不需要额外的记号约定。
 */
export function extractElementIds(text: string): string[] {
  const seen = new Set<string>()
  const ids: string[] = []
  for (const match of text.matchAll(ELEMENT_TOKEN)) {
    const id = match[1]!
    if (seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids
}

/** 生成草稿 id：时间前缀保证大致有序，序号后缀保证同毫秒内唯一。 */
export function newDraftId(now: number, seq: number): string {
  return 'drf_' + now.toString(36) + '_' + seq.toString(36)
}

/** 草稿服务接口。 */
export interface DraftService {
  /** 保存一条草稿。超整次上限时抛错（调用方据此回失败）。 */
  save(payload: DraftSavePayload): Promise<{ record: DraftRecord; warnings: string[] }>
  /** 全部草稿，按 createdAt 升序。 */
  list(): DraftRecord[]
  /** 按 id 取一条。 */
  get(id: string): DraftRecord | undefined
  /** 把某条置为 active 并清除其余；传 null 清除全部。 */
  setActive(id: string | null): void
  /** 删除一条并回收无引用资产。 */
  remove(id: string): { removed: boolean; reclaimed: number }
  /** 当前所有记录仍引用的资产 ref 集合。 */
  referencedAssetRefs(): Set<string>
}

/**
 * 创建草稿服务。
 * @param options.maxAttachmentBytes - 单附件上限，超过则该附件降级为只存元信息。
 * @param options.maxDraftBytes - 单草稿字节上限，超过则整次保存失败。
 * @param options.maxRecords - jsonl 行数上限，超过即压紧。
 * @param options.onWarn - 降级/回收等可继续情况的回调，交给调用方记日志。
 */
export function createDraftService(options: {
  store: DraftStore
  assets: AssetStore
  elements: ElementSource
  maxAttachmentBytes: number
  maxDraftBytes: number
  maxRecords: number
  onWarn?: (msg: string) => void
}): DraftService {
  const { store, assets, elements, maxAttachmentBytes, maxDraftBytes, maxRecords, onWarn } = options
  let seq = 0

  /** 汇总当前所有记录引用的资产 ref（删除后据此判断能否回收）。 */
  const referencedAssetRefs = (): Set<string> => {
    const refs = new Set<string>()
    for (const record of store.load()) {
      for (const attachment of record.content.attachments) {
        if (attachment.asset !== undefined) refs.add(attachment.asset.ref)
      }
    }
    return refs
  }

  /**
   * 压紧日志，**失败只告警**。
   *
   * 压紧是优化而非写入本身：调用它时目标记录（upsert 或墓碑）已经落盘生效，
   * 所以 temp+rename 失败（家目录只读、磁盘写满）绝不能向上抛——那会让路由回
   * `ok:false`，用户看到「保存失败／删除失败」而其实已经成功，是在另一个方向上撒谎。
   * 与 index.ts 启动期清扫同一处置口径。
   *
   * 调用时机由调用方决定：删除后**无条件**压紧（否则墓碑与已删记录的 upsert 会一直
   * 留在日志里，`recordCount()` 也不再回落）；保存时只在越过阈值才压紧，免得把一次
   * 全量读取放进保存热路径。
   */
  const compactQuietly = (): void => {
    try {
      store.compact()
    } catch (err) {
      onWarn?.('日志压紧失败（不影响本次写入，下次再试）: ' + String((err as Error)?.message || err))
    }
  }

  /** 保存路径专用：只有越过阈值才值得付 recordCount() 那次全量读取。 */
  const compactIfOverThreshold = (): void => {
    try {
      if (store.recordCount() > maxRecords) store.compact()
    } catch (err) {
      onWarn?.('日志压紧失败（不影响本次写入，下次再试）: ' + String((err as Error)?.message || err))
    }
  }

  return {
    async save(payload: DraftSavePayload): Promise<{ record: DraftRecord; warnings: string[] }> {
      const warnings: string[] = []

      // 1) 先算总字节：单附件超限只降级；整次超限在落「记录」之前抛错——
      // 但 assets.put 就在这个循环里逐附件落盘，故超限时已写下的字节会成为孤儿资产（无记录引用，下一次 GC 回收）。
      let totalBytes = 0
      const attachmentRecords: DraftAttachmentRecord[] = []
      for (const incoming of payload.attachments) {
        const decoded = incoming.base64 === undefined
          ? undefined
          : new Uint8Array(Buffer.from(incoming.base64, 'base64'))
        if (decoded === undefined) {
          warnings.push('附件「' + incoming.name + '」未携带字节，已降级为仅记录元信息')
          attachmentRecords.push({ name: incoming.name, mediaType: incoming.mediaType, size: incoming.size, kind: incoming.kind, degraded: true })
          continue
        }
        totalBytes += decoded.byteLength
        if (decoded.byteLength > maxAttachmentBytes) {
          warnings.push('附件「' + incoming.name + '」超过单附件上限，已降级为仅记录元信息')
          attachmentRecords.push({ name: incoming.name, mediaType: incoming.mediaType, size: incoming.size, kind: incoming.kind, degraded: true })
          continue
        }
        const put = assets.put(decoded)
        attachmentRecords.push({
          name: incoming.name,
          mediaType: incoming.mediaType,
          size: incoming.size,
          kind: incoming.kind,
          asset: { sha256: put.sha256, ref: put.ref },
          degraded: false,
        })
      }
      if (totalBytes > maxDraftBytes) {
        throw new Error('草稿总字节 ' + totalBytes + ' 超过上限 ' + maxDraftBytes + '，已取消保存')
      }

      // 2) 元素：正文说了要哪些编号就只查哪些；查询失败在来源内部已降级
      const ids = extractElementIds(payload.text)
      const resolvedElements = await elements.lookup(ids)

      const now = Date.now()
      seq += 1
      const record: DraftRecord = {
        id: newDraftId(now, seq),
        createdAt: now,
        originSessionId: payload.originSessionId,
        ...(payload.originLabel !== undefined && payload.originLabel !== ''
          ? { originLabel: payload.originLabel }
          : {}),
        active: false,
        content: {
          text: payload.text,
          attachments: attachmentRecords,
          elements: resolvedElements,
        },
      }

      // 3) 资产已就位，才追加记录
      store.appendUpsert(record)

      // 压紧是**优化**，不是保存的一部分：记录此时已经落盘，压缩失败不能让整次保存
      // 报成失败——那是在另一个方向上撒谎（用户会以为没存上，其实存上了）。
      // 与启动期清扫同一处置：失败只告警。保存路径按阈值判断，避免热路径全量读取。
      compactIfOverThreshold()

      onWarn?.('草稿已保存 ' + record.id
        + '（附件 ' + attachmentRecords.length + '，元素 ' + resolvedElements.length + '）')
      return { record, warnings }
    },

    list(): DraftRecord[] {
      return store.load()
    },

    get(id: string): DraftRecord | undefined {
      return store.load().find((record) => record.id === id)
    },

    setActive(id: string | null): void {
      // 单次遍历写回：只有真正变化的记录才追加一行，避免每次回弹刷出一堆无意义日志
      for (const record of store.load()) {
        const next = record.id === id
        if (record.active === next) continue
        store.appendUpsert({ ...record, active: next })
      }
    },

    remove(id: string): { removed: boolean; reclaimed: number } {
      const exists = store.load().some((record) => record.id === id)
      if (!exists) return { removed: false, reclaimed: 0 }
      store.appendDelete(id, Date.now())
      // 记录已删，再按剩余引用回收资产
      const reclaimed = assets.collectGarbage(referencedAssetRefs())
      // 同 save：删除本身已经生效，压缩失败不该让用户看到「删除失败」
      compactQuietly()
      return { removed: true, reclaimed }
    },

    referencedAssetRefs,
  }
}
