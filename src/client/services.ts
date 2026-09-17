/**
 * Client 侧服务契约——本插件从 harness web 半边消费的精确 API 表面。
 *
 * 仅类型：运行时服务来自用户的 harness（ui-slots 等组合包）。槽位组件所需
 * 的标准 props 由框架注入，这里只把本插件实际读取到的字段窄化下来。
 */

import type { Context } from '@deepseek-ai/cordis'

/**
 * 本插件注册的槽位项参数（`conversation.input.left` / `conversation.view` /
 * `conversation.composer.dock` 都是 `kind: 'list'`，因此 `id` 必填、`order` 决定排序）。
 */
export interface SlotRegistration {
  name: string
  id: string
  order?: number
  /**
   * 列表项的展示名。`conversation.view` 的 tab 文案走这里（`label: () => '草稿'`）；
   * 宿主按 thunk 逐个读取，因此注册期文案能随语言环境变化而无需重新注册。
   */
  label?: () => string
  /**
   * 注入工厂：返回值会被框架摊进组件的 props。
   *
   * **`ctx` 只能这样进组件**——props 由框架构造，`ctx` 不在其中；把 root ctx
   * 闭包进工厂、再经 `props.ctx` 读，是同一份代码里 `ui-chat` 的既有做法。
   */
  inject?: () => Record<string, unknown>
}

/** harness 槽位服务（`ctx.slots`）。 */
export interface SlotsService {
  /** 等待某槽位声明出现后再注册，返回清理器。 */
  inject(name: string, callback: () => () => void): () => void
  register(registration: SlotRegistration, component: (props: Record<string, unknown>) => unknown): () => void
}

/** 输入框草稿状态（槽位标准 props `useInput` 的投影）。 */
export interface InputStateLike {
  readonly draft: string
  /** 有序的浏览器侧附件 id（`resolveDraftAttachments` 的入参）。 */
  readonly attachmentIds: readonly string[]
  /** 提交面的阶段：非 `plain` 即「正忙」，此时附件写入会被拒。 */
  readonly phase: 'plain' | 'adjudicating' | 'claimed' | 'submitting'
}

/** 输入框动作面（槽位标准 props `inputActions`）。 */
export interface InputActionsLike {
  setDraft?(draft: string): void
  /** 追加浏览器侧附件 id；busy 阶段会拒（返回 false，什么都不加）。 */
  addAttachments?(ids: readonly string[]): boolean
  /**
   * 移除一个浏览器侧附件 id（保存成功后清空输入框时逐个摘）。
   *
   * 与 `addAttachments` 同属「有就调、没有就降级」的可选成员：harness 升级把这几个
   * 方法改名是完全可能的，存在性校验因此留在调用点（见 `composer-bridge.ts` 的
   * `clearComposer`），而不是在这里声明成必填、让调用点直接炸成
   * `undefined is not a function`。
   * 契约（ui-conversation `contract/input.ts`）：`removeAttachment(id)`；busy 阶段同样会拒。
   */
  removeAttachment?(id: string): void
}

/** 上传到 host 的通用文件凭据（只声明本插件读取到的字段）。 */
export interface FileAttachmentRefLike { readonly receiptId: string }

/**
 * `conversation.input.dock` 槽位的 owner 面（`InputZone`）里那条会话视图快照。
 *
 * 只窄化本插件判定「新会话 / hero」所需的字段——它是 `InputZone.session`，
 * 由框架摊进槽位 props（实测 props 里 `session` 与 `input` 都在）。
 */
export interface SessionSnapshotLike {
  /**
   * 这条会话视图还没有任何历史：新会话（hero）页为 true，打开已有会话后为 false。
   *
   * 它是「会话页 / 新会话页」的判定依据——**不是 sessionId**：实机探针显示两种
   * 状态下 sessionId 都已定义（hero 承载的是一条 blank 会话）。
   */
  readonly blank?: boolean
}

/** 浏览器拥有的草稿附件（与 ComposerAttachment 同形，只取本插件用到的字段）。 */
export type ComposerAttachmentLike =
  | { kind: 'image'; id: string; file: Blob }
  | { kind: 'file'; id: string; file: Blob }

/**
 * `ui-conversation` 的 ConversationController 面。
 * 它是「root singleton, provided as `conversation`」，因此经 ctx.get('conversation') 取。
 * resolveDraftAttachments / createDrafts / releaseDraftAttachments 是包内面而非文档化
 * 公开面——适配层必须做运行时方法存在性校验，缺失时抛出明确错误（见 spec §7-2）。
 * （`addAttachments` 不在本服务上：它是输入框动作面 `InputActionsLike` 的方法。）
 */
export interface ComposerFace {
  resolveDraftAttachments(ids: readonly string[]): readonly ComposerAttachmentLike[]
  createDrafts(sessionId: string, files: readonly Blob[]): readonly { id: string }[]
  /**
   * 归还一组成员（按各自的 `id`）：注销草稿对象、停掉后台上传、回收图片预览 URL。
   *
   * `createDrafts` 建出来的东西全由浏览器侧持有，只有这个方法能把它们还回去。
   * 附件被输入框拒收时必须调用它——宿主 `ui-conversation` 在等价的 `addFiles`
   * 路径上做的正是这件事（`createDrafts` → `addAttachments` 返回 false →
   * `releaseDraftAttachments`）；不调用则草稿与后台上传都成了没人引用的孤儿。
   */
  releaseDraftAttachments(attachments: readonly { id: string }[]): void
}

/**
 * `conversation.input.left` 上保存按钮读取的标准 props。
 *
 * 用 **type alias 而不是 interface**：`index.ts` 要把组件断言成
 * `(props: Record<string, unknown>) => unknown`，而只有对象字面量类型别名会拿到
 * 隐式索引签名（interface 不会），断言才成立。
 */
export type SaveDraftButtonProps = {
  /** 当前会话 id（session 作用域的框架标准 prop）。 */
  sessionId: string
  /** root ctx，经槽位注册的 `inject` 工厂摊进 props。 */
  ctx: ClientCtx
  useInput?<T>(selector: (state: InputStateLike) => T): T
  inputActions?: InputActionsLike
}

/**
 * `conversation.view` 上草稿 tab 读取的标准 props（`ConvViewProps` 的窄化）。
 *
 * 与 `SaveDraftButtonProps` 同理，必须是 **type alias 而不是 interface**：
 * `index.ts` 要把组件断言成 `(props: Record<string, unknown>) => unknown`，而只有
 * 对象字面量类型别名会拿到隐式索引签名（interface 不会），断言才成立。
 */
export type DraftViewProps = {
  /** 当前会话 id（session 作用域的框架标准 prop）。 */
  sessionId: string
  /** root ctx，经槽位注册的 `inject` 工厂摊进 props。 */
  ctx: unknown
  useInput?<T>(selector: (state: InputStateLike) => T): T
  inputActions?: InputActionsLike
}

/**
 * `conversation.input.dock` 上「最近草稿」列表读取的标准 props。
 *
 * `useInput` 不在 brief 的窄化清单里，但这里**必须**读它：要判断输入框非空、
 * 避免无确认覆盖，只能读它。
 *
 * `session` 也是同一类「brief 没写、但实测在 props 里」的字段：它是 InputZone 的
 * 会话视图快照，本插件用它判定 hero 态（见 `list-scope.ts`——该槽位在会话页同样渲染，
 * 只靠它才能把列表收在 hero）。
 * 同样是 type alias，理由同上。
 */
export type DraftStripProps = {
  /** 当前会话 id（session 作用域的框架标准 prop）。 */
  sessionId: string
  /** root ctx，经槽位注册的 `inject` 工厂摊进 props。 */
  ctx: unknown
  /** 会话视图快照（InputZone.session）：hero 判定读它的 `blank`。 */
  session?: SessionSnapshotLike
  useInput?<T>(selector: (state: InputStateLike) => T): T
  inputActions?: InputActionsLike
}

/**
 * Client 上下文：cordis 上下文加上本插件注入的服务。
 *
 * `conversation` 不经 cordis 注入声明（`inject: ['slots']` 里没有它），而是运行时
 * `ctx.get('conversation')` —— 它不是本插件的硬依赖：缺失时只影响附件能力，
 * 不该让整个插件挂起。
 */
export type ClientCtx = Context & {
  slots: SlotsService
}
