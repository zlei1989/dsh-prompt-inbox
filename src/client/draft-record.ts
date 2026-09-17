/**
 * 草稿记录 → 列表文本的纯函数转换（client 半）。
 *
 * 这里刻意不碰 DOM、不碰 React、不读时钟：草稿列表与面板（Task 8/9）都从这里
 * 取文本，而本模块能在 Node 里直接单测。所有导出都是入参的纯函数。
 */

import type { DraftRecord } from '../shared/types.ts'

/**
 * base64 的分块大小。
 *
 * `String.fromCharCode(...bytes)` 会把每个字节摊成一个实参，几 MB 的附件直接
 * 爆调用栈（"Maximum call stack size exceeded"）。0x8000 = 32768 个实参，
 * 远低于引擎上限，也不至于把循环切得过碎。
 */
const BASE64_CHUNK = 0x8000

/**
 * 字节 → base64（`DraftSavePayload.attachments[].base64` 需要）。
 *
 * 浏览器侧用全局 `btoa`；Node 24 同样提供 `btoa`，因此单测不需要替身。
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK))
  }
  return btoa(binary)
}

/**
 * 正文 → 单行：所有空白折叠成一个空格、去掉首尾，空文本回占位符。**不截断**。
 *
 * 卡片上的正文走这一条而不是 `previewLine`：宽度该由 CSS 的 `text-overflow: ellipsis`
 * 按真实可用宽度裁决，写死的字符数只会抢在它前面切——实测 60 字上限在 798px 宽的
 * 列表里远没到溢出的位置就先把正文砍了，于是"超出范围才省略号"永远看不到，
 * 展开后也补不回被砍掉的字。
 *
 * @param text - 草稿正文原样（可能含换行与缩进）。
 */
export function flattenLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat === '' ? '(空草稿)' : flat
}

/**
 * 正文 → 单行预览：在 `flattenLine` 之上按 `max` 个字符截断并以 `…` 结尾。
 *
 * 留给**有硬性长度约束**的地方——可访问名、`title` 提示这类不能塞整篇正文的属性。
 * 卡片正文本身不用它（见 `flattenLine`）。
 *
 * @param text - 草稿正文原样（可能含换行与缩进）。
 * @param max - 预览的最大字符数，默认 60。
 */
export function previewLine(text: string, max = 60): string {
  const flat = flattenLine(text)
  return flat.length > max ? flat.slice(0, max) + '…' : flat
}

/**
 * 列表项的计数摘要：`N 个附件 · N 个元素`，计数为 0 的组不出现。
 *
 * 降级项（`degraded === true`，即只存了元信息、没存内容）单独点名，因为用户
 * 回弹时拿不回它们：降级附件缺字节、降级元素只有摘要。两类都计入，但**按组
 * 各报一条**（`N 项降级附件` / `N 项降级元素`），这样两组降级在列表上都可见，
 * 不会出现「只报了附件、元素降级看不出来」。
 *
 * @remarks
 * brief 的 Step 3 把降级数描述成「降级附件数 + 降级元素数」的单一 `· N 项降级`，
 * 但同一份 brief 的用例对「1 个降级附件 + 1 个降级元素」断言 `/1 项降级/`：
 * 求和会输出 `2 项降级`，那条断言必然失败，规格与测试不可兼得。本实现选择
 * 不丢信息的分组计数（测试逐字通过，两类降级都可见），取舍记在
 * `.superpowers/sdd/2026-09-16-prompt-inbox-drafts/task-7-report.md`。
 */
export function summarize(record: DraftRecord): string {
  const { attachments, elements } = record.content
  const parts: string[] = []
  if (attachments.length > 0) parts.push(attachments.length + ' 个附件')
  if (elements.length > 0) parts.push(elements.length + ' 个元素')
  const degradedAttachments = attachments.filter((item) => item.degraded).length
  if (degradedAttachments > 0) parts.push(degradedAttachments + ' 项降级附件')
  const degradedElements = elements.filter((item) => item.degraded).length
  if (degradedElements > 0) parts.push(degradedElements + ' 项降级元素')
  return parts.join(' · ')
}

/**
 * 来源会话标注：草稿属于当前会话时不标注（返回 `undefined`），
 * 属于其他会话时优先用 `originLabel`，取不到就退到 `originSessionId` 前 8 字符。
 */
export function sessionBadge(record: DraftRecord, currentSessionId: string): string | undefined {
  if (record.originSessionId === currentSessionId) return undefined
  return record.originLabel ?? record.originSessionId.slice(0, 8)
}

/**
 * 是否存在「回弹时真的能把字节取回来」的附件：非降级**且**带 `asset` 引用。
 *
 * 降级附件只存了元信息，回弹时只能跳过并计数，因此不能算可恢复。
 */
export function hasRestorableAttachments(record: DraftRecord): boolean {
  return record.content.attachments.some((item) => item.degraded === false && item.asset !== undefined)
}
