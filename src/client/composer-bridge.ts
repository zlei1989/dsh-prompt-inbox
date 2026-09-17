/**
 * composer 适配层：唯一读 `ctx.get('conversation')` 包内面的地方。
 * 把「可能变形的包内面」收在一个函数里，缺失时抛出可定位的错误。
 *
 * 背景（spec §7-2）：`resolveDraftAttachments` / `createDrafts` / `releaseDraftAttachments`
 * 是 `ui-conversation` 的**包内面**，不是文档化公开 API。harness 升级把它们改名或改形是完全可能的，
 * 而真发生了必须**在这里响亮地失败**（错误信息点名方法），而不是让每个调用点各自
 * 报一句 `undefined is not a function`。
 *
 * 依赖方向：本模块只碰 composer 与 `fetch`/`File` 两个浏览器全局，不认识 React。
 */

import { assetUrl, logError } from './host-call.ts'
import { bytesToBase64 } from './draft-record.ts'
import type { ClientCtx, ComposerFace, InputActionsLike } from './services.ts'
import type { DraftRecord, DraftSavePayload } from '../shared/types.ts'

/**
 * 取 ConversationController 并校验它仍然提供本插件依赖的方法。
 *
 * 校验表覆盖本适配层**实际调用到的每一个**包内面方法：漏一个，那个方法被
 * harness 改名后就会在调用点炸成 `undefined is not a function`。
 *
 * @param ctx - client 上下文。
 * @returns 同一份 conversation 服务（校验通过即为 `ComposerFace`）。
 * @throws conversation 服务缺失，或它已不再提供 `resolveDraftAttachments` /
 *   `createDrafts` / `releaseDraftAttachments` 中的任意一个。
 */
export function resolveComposer(ctx: ClientCtx): ComposerFace {
  const conversation = ctx.get('conversation') as Partial<ComposerFace> | undefined
  if (conversation === undefined) {
    throw new Error('conversation 服务不可用：无法保存/回弹附件')
  }
  for (const method of ['resolveDraftAttachments', 'createDrafts', 'releaseDraftAttachments'] as const) {
    if (typeof conversation[method] !== 'function') {
      throw new Error('conversation 服务的 ' + method + ' 已不可用（harness 升级可能改了包内面），请升级本插件')
    }
  }
  return conversation as ComposerFace
}

/**
 * 附件名。
 *
 * 包内面的 `ComposerAttachment.file` 实际是 `File`（`ComposerFileAttachment` /
 * `ComposerImageAttachment` 都声明为 `File`），但本插件只把用到的字段窄化到
 * `Blob`；这里做一次读取，名字原样透传（host 侧会把它写进记录、拼进降级警告）。
 */
function fileNameOf(file: Blob): string {
  const named = file as File
  return typeof named.name === 'string' ? named.name : ''
}

/**
 * 输入框里是否有可保存的内容：正文去掉空白后非空，**或**带着附件。
 *
 * 放在本模块而不是组件文件里，是为了能在 Node 单测里直接跑：组件模块 import 了
 * react（仓库里只有 `@types/react`，没有 react 运行时），测试环境加载不了它。
 * 这条判定单独可测，组件是否用它仍只能靠读代码/端到端看（Task 10）。
 *
 * @param draft - 输入框正文（原样，可能全是空白）。
 * @param attachmentIds - 有序附件 id。
 */
export function hasComposerContent(draft: string, attachmentIds: readonly string[]): boolean {
  return draft.trim() !== '' || attachmentIds.length > 0
}

/**
 * 采集输入框现状，组装成 host `draft-save` 需要的载荷。
 *
 * `elements` 恒为空数组：正文里的 `[DOMn]` 由 host 从正文提取（client 不解析占位符）。
 *
 * @param composer - 已校验的 conversation 面。
 * @param sessionId - **当前**会话 id（保存发生在哪就记在哪，与草稿来源无关）。
 * @param input - 输入框现状：正文与有序附件 id。
 * @returns 可直接提交给 host 的载荷（附件字节已 base64）。
 */
export async function snapshotDraft(
  composer: ComposerFace,
  sessionId: string,
  input: { draft: string; attachmentIds: readonly string[] },
): Promise<DraftSavePayload> {
  const attachments = composer.resolveDraftAttachments(input.attachmentIds)
  const encoded: DraftSavePayload['attachments'] = []
  for (const attachment of attachments) {
    const file = attachment.file
    const bytes = new Uint8Array(await file.arrayBuffer())
    encoded.push({
      name: fileNameOf(file),
      mediaType: file.type || 'application/octet-stream',
      size: file.size,
      kind: attachment.kind,
      base64: bytesToBase64(bytes),
    })
  }
  return {
    text: input.draft,
    originSessionId: sessionId,
    attachments: encoded,
    elements: [],
  }
}

/**
 * 清空输入框：正文与附件**一起**清。
 *
 * 为什么必须连附件一起清：全仓库「输入框里有没有东西」只有 `hasComposerContent`
 * 这一份判定（正文**或**附件），只清正文会让「只剩附件」的输入框继续算有内容——
 * 保存按钮照旧挂在工具行上，用户看到的就不是「已清空」。
 *
 * **不抛**：调用它时草稿已经存进 host（保存成功），清空这一步失败不能反过来把整次保存
 * 说成失败——用户会以为要重存，存出第二条一模一样的草稿。而这个失败在界面上本来就
 * **看得见**（正文还在输入框里），所以两条降级路径都只留一条带上下文的 ERROR 日志：
 *   · `setDraft` 缺失（harness 改了输入动作面）→ **整体不动**：半清空（正文没了、附件还在）
 *     比不清空更糟，用户既丢了内容又没得到「已清空」；
 *   · `removeAttachment` 缺失 → 正文照清、附件留下，同样留痕。
 *
 * 顺序：先正文、再逐个摘附件。两者在 busy 阶段的表现不同（`removeAttachment` 会被拒、
 * `setDraft` 不会），但保存按钮在 busy 阶段本来就是 disabled、到不了这里；先清正文是因为
 * 它是用户看得见的主要那一块。
 *
 * 放在本模块而不是组件里：与 `hasComposerContent` 同源（判定与清空必须对着同一份定义），
 * 且不含 React，能在 Node 单测里跑真身。
 *
 * @param inputActions - 槽位标准 props 的输入动作面（成员全可选，逐个做存在性校验）。
 * @param attachmentIds - 输入框当前的有序附件 id（清哪些由调用方观测到的现状决定）。
 */
export function clearComposer(inputActions: InputActionsLike, attachmentIds: readonly string[]): void {
  if (typeof inputActions.setDraft !== 'function') {
    logError('inputActions.setDraft 不可用：保存成功但未能清空输入框（harness 升级可能改了输入动作面）')
    return
  }
  inputActions.setDraft('')
  if (attachmentIds.length === 0) return
  if (typeof inputActions.removeAttachment !== 'function') {
    logError('inputActions.removeAttachment 不可用：正文已清空，但 ' + attachmentIds.length + ' 个附件仍留在输入框里')
    return
  }
  for (const id of attachmentIds) inputActions.removeAttachment(id)
}

/**
 * 把一条草稿回弹进输入框。
 *
 * **顺序不可倒**：先 `createDrafts` + `addAttachments`，最后才 `setDraft`。
 * 理由是两条硬约束叠在一起——`addAttachments` 在提交面 busy 阶段会被直接拒
 * （返回 false），而 `setDraft` 是**整体替换**语义；先写正文再塞附件，一旦附件被拒，
 * 用户看到的就是一条「有正文、没附件」的假成功，且已无原内容可回退。
 *
 * 附件写入被拒（busy，`addAttachments` 返回 false）时，先经 `releaseDraftAttachments`
 * 把刚建出来的那批附件**归还**再抛错：它们既进不了输入框，也永远留在浏览器侧
 * （草稿对象 + 后台上传 + 预览 URL 全无引用），归还与抛错缺一不可。
 *
 * 附件字节取不回来（降级项、无 asset 引用、HTTP 失败、读字节抛错）只让**那一个**
 * 附件降级为跳过并计入 `missing`，不让整次回弹失败。
 *
 * @param composer - 已校验的 conversation 面。
 * @param sessionId - 回弹目标会话（当前会话，不是草稿的来源会话）。
 * @param record - 目标草稿（含附件与 asset 引用）。
 * @param inputActions - 槽位标准 props 的输入动作面。
 * @param assetUrls - `draft-get` 返回的 ref → 完整请求路径映射；缺项时按 ref 拼。
 * @returns `restored` = 真正重建并加入输入框的附件数；`missing` = 未能恢复的附件数。
 * @throws 输入动作面缺方法，或附件写入被输入框拒收（此时正文不会写入，
 *   且已建出来的附件对象已被归还）。
 */
export async function restoreDraft(
  composer: ComposerFace,
  sessionId: string,
  record: DraftRecord,
  inputActions: InputActionsLike,
  assetUrls: Record<string, string>,
): Promise<{ restored: number; missing: number }> {
  if (typeof inputActions.setDraft !== 'function') {
    throw new Error('inputActions.setDraft 不可用：无法把正文写回输入框')
  }

  const files: File[] = []
  let missing = 0
  for (const attachment of record.content.attachments) {
    const asset = attachment.asset
    if (attachment.degraded || asset === undefined) {
      // 降级项只存了元信息，字节在保存时就丢了；没有 asset 的项也没有可取字节的引用
      missing += 1
      continue
    }
    try {
      // host 的 assetUrls[ref] 已经是「路径 + 已编码查询串」，直接拿它请求；
      // 再套一层 assetUrl 会把整条路径当成 ref 二次编码，host 的 ref 校验必然拒绝。
      // assetUrls 缺项时才回退到按 ref 现拼。
      const res = await fetch(assetUrls[asset.ref] ?? assetUrl(asset.ref))
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const bytes = await res.arrayBuffer()
      files.push(new File([bytes], attachment.name, { type: attachment.mediaType }))
    } catch (err) {
      logError('附件字节读取失败：' + attachment.name, err)
      missing += 1
    }
  }

  if (files.length > 0) {
    if (typeof inputActions.addAttachments !== 'function') {
      throw new Error('inputActions.addAttachments 不可用：无法把附件放回输入框')
    }
    const drafts = composer.createDrafts(sessionId, files)
    if (!inputActions.addAttachments(drafts.map((draft) => draft.id))) {
      // 拒收就得把刚建出来的附件还回去：`createDrafts` 为图片登记了草稿对象并起了
      // 尺寸探测（带预览 URL）、为每个非图片文件起了后台上传；不还它们就全是没人
      // 引用的孤儿（上传照跑、内存照占）。宿主 `ui-conversation` 的 `addFiles` 在
      // 同一处拒收时做的正是这一句。
      composer.releaseDraftAttachments(drafts)
      throw new Error('输入框正忙，附件未能加入；请等当前提交结束后重试')
    }
  }

  inputActions.setDraft(record.content.text)
  return { restored: files.length, missing }
}
