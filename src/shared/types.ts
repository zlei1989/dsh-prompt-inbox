/**
 * 跨 host ↔ client 边界交换的纯 JSON 形状。
 *
 * 两端运行在不同程序里（Node 与浏览器页面），只能经 harness webserver 路由
 * 以 JSON 交换这些值。因此本文件没有任何运行时导入——两端都只用它做类型约束。
 */

/** 一条附件在草稿里的记录。degraded 为 true 表示只存了元信息，没有字节。 */
export interface DraftAttachmentRecord {
  name: string
  mediaType: string
  size: number
  kind: 'image' | 'file'
  /** 内容寻址引用；degraded 为 true 时缺失。 */
  asset?: { sha256: string; ref: string }
  degraded: boolean
}

/**
 * 一条被 [DOMn] 引用的页面元素快照。
 * payload 为 null 表示只拿到摘要（当前常态，见 spec §3.4）。
 */
export interface DraftElementRecord {
  id: string
  pageUrl?: string
  label?: string
  payload: Record<string, unknown> | null
  degraded: boolean
}

/** 草稿的完整内容。 */
export interface DraftContent {
  /** 输入框正文原样保存，含 @ 引用与 [DOMn] 的字面形式。 */
  text: string
  attachments: DraftAttachmentRecord[]
  elements: DraftElementRecord[]
}

/** 一条草稿记录（host 发号）。 */
export interface DraftRecord {
  id: string
  createdAt: number
  originSessionId: string
  /** 来源会话的展示名，客户端尽力解析；取不到则显示 id 前缀。 */
  originLabel?: string
  /** 当前输入框内容是否来自它。 */
  active: boolean
  content: DraftContent
}

/** client 提交保存时的载荷（id/createdAt/active 由 host 决定）。 */
export interface DraftSavePayload {
  text: string
  originSessionId: string
  originLabel?: string
  attachments: Array<{
    name: string
    mediaType: string
    size: number
    kind: 'image' | 'file'
    /** 附件字节的 base64；超上限时省略，该附件降级。 */
    base64?: string
  }>
  elements: DraftElementRecord[]
}

/** jsonl 里的一行。 */
export type DraftLogLine =
  | { op: 'upsert'; record: DraftRecord }
  | { op: 'delete'; id: string; at: number }

/** `/invoke` 的统一信封。 */
export interface InvokeResult {
  ok: boolean
  error?: string
  records?: DraftRecord[]
  record?: DraftRecord
  /** `draft-get` 附带：附件 id → host 上可取字节的 URL。 */
  assetUrls?: Record<string, string>
  /** 表示这次失败是「降级后仍成功」的说明，UI 需要展示。 */
  warnings?: string[]
}
