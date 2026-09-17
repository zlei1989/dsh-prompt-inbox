/**
 * 回弹动作：草稿 tab 与空会话草稿列表共用这一份实现，避免两处各写一遍
 * 「取记录 → 确认覆盖 → 恢复附件 → 写正文 → 置 active」的顺序逻辑。
 *
 * 顺序不可倒：必须先塞附件再写文字，因为 addAttachments 在 busy 阶段会被拒
 * （顺序本身由 `composer-bridge.ts` 的 `restoreDraft` 保证，这里不重复也不重排）。
 *
 * 本模块刻意不 import react：判定与动作因此能在 Node 里直接单测。两个界面组件
 * （`DraftView` / `DraftStrip`）加载不了——仓库只装了 `@types/react`，没有 react
 * 运行时——所以「组件是否据此弹确认面板」仍只能由 Task 10 端到端验证。
 */

import { hostCall, logError } from './host-call.ts'
import { hasComposerContent, resolveComposer, restoreDraft } from './composer-bridge.ts'
import { noteRestored } from './active-draft.ts'
import type { ClientCtx, InputActionsLike } from './services.ts'
import type { DraftRecord, InvokeResult } from '../shared/types.ts'

/** 回弹结果，供调用方决定提示文案。 */
export interface RestoreOutcome {
  ok: boolean
  error?: string
  /** 未能恢复的附件数（资产缺失或下载失败）。 */
  missing: number
  /**
   * 「内容已经回弹进去了，但有一步没做成」的警告（目前只有置 active 失败）。
   *
   * 与 `error` 互斥：带 warning 的结果 `ok` 恒为 true——正文确实写进了输入框，
   * 报成失败会让用户以为要重做一次。界面必须把它与成功文案**一起**展示
   * （见 `restoreNotice`）：只报成功会让「当前」没标上这件事无人知晓，只报警告
   * 又看起来像失败了。
   */
  warning?: string
}

/** 置 active 失败时交给界面的那句警告：措辞必须点明「内容已经回弹了」。 */
const SET_ACTIVE_WARNING = '草稿已回弹，但未能标记为当前草稿'

/**
 * 回弹前是否必须先确认覆盖。
 *
 * `setDraft` 是**整体替换**语义：输入框里已有的正文与附件会被无条件丢掉，所以非空
 * 时先问一句；输入框是空的就没有可丢的东西，直接回弹——不给没有代价的操作加摩擦。
 *
 * 判定与保存按钮的「有内容才出现」同源（`hasComposerContent`）：两处问的都是
 * 「输入框里有没有东西」，各写一份真值表迟早会漂移。草稿 tab 与空会话列表都调它
 * （后者不是只在 hero 态渲染，见 `DraftStrip` 的注释：不确认就会静默覆盖正在写的内容）。
 *
 * 放在这里而不是组件里，是为了能在 Node 单测里直接跑真身；组件模块 import react，
 * 测试环境加载不了。用例名因此只说判定，不说「弹面板」。
 *
 * @param draft - 输入框正文（原样，可能全是空白）。
 * @param attachmentIds - 输入框当前的有序附件 id。
 * @returns 输入框非空（有正文或有附件）时为 true。
 */
export function shouldConfirmOverwrite(draft: string, attachmentIds: readonly string[]): boolean {
  return hasComposerContent(draft, attachmentIds)
}

/**
 * 把草稿置为「当前」（jsonl 追加）。
 *
 * **不抛**：调用它时正文已经写进输入框（`setDraft` 是整体替换语义，回不去），所以
 * 这一步失败不能把整次回弹说成失败。但它是一次真实的磁盘写失败，也**不能静默**：
 * 吞掉的话界面上是「已回弹草稿」、列表里却没有一条标着「当前」，控制台也一片安静
 * ——正是本插件在 `e71453e` 里刚修掉的那一类问题。所以两条失败路径都留一条带业务
 * 上下文的 ERROR 日志，并把 warning 交回调用方。
 *
 * `hostCall` 在 HTTP 非 2xx / 网络故障时会抛，业务失败则是 HTTP 200 上的
 * `{ ok: false }`——两种都是「没标上」，走同一个出口。
 *
 * @param id - 目标草稿 id（只用它定位）。
 * @returns 成功为 undefined；失败为可直接展示的中文警告（已记日志）。
 */
async function markActive(id: string): Promise<string | undefined> {
  try {
    const marked: InvokeResult = await hostCall('draft-set-active', { id })
    if (marked.ok) return undefined
    logError('标记当前草稿失败（草稿已回弹，列表不会标出「当前」）：' + id, marked.error)
  } catch (err) {
    logError('标记当前草稿失败（草稿已回弹，列表不会标出「当前」）：' + id, err)
  }
  return SET_ACTIVE_WARNING
}

/**
 * 把一条草稿回弹进输入框。
 *
 * 记录**重新从 host 取**：`record` 往往来自列表快照，可能已经过期，而回弹要写进
 * 输入框的是 jsonl 里的当前内容。取失败就直接返回错误，不碰输入框。
 *
 * **本函数不 reject**：`draft-get` 这一步也包在 try 里，因为 `hostCall` 在 HTTP
 * 非 2xx / 网络故障时会抛。抛出去的话，两个入口的调用链都没有 catch（界面也没有
 * 任何提示，控制台只多一条未处理的 rejection），而 `RestoreOutcome` 的约定正是
 * 「失败时 error 已可直接展示」——所以把传输层失败也折成 `ok:false`。
 *
 * 置 active 是**例外**：它发生在正文已经写进输入框之后，两种失败都折成 `ok:true`
 * + `warning`（见 `markActive`），既不谎报失败、也不静默。
 *
 * 最后一个副作用：内容确实进了输入框之后调 `noteRestored`，把「输入框装的是这条草稿」
 * 交给 `active-draft` 的协调器记着——输入框清空时由它发出那一次复位请求（清 `active`
 * 标志与元素激活集）。**只有成功路径记**：失败却记下来，下一次空输入框就会去清掉一份
 * 不属于这条草稿的激活集。
 *
 * @param ctx - client 上下文（用于取 conversation 服务）。
 * @param sessionId - 回弹目标会话；是**当前会话**而非草稿的来源会话。
 * @param record - 目标草稿（只用它的 id 定位，正文/附件以 host 返回的为准）。
 * @param inputActions - 槽位标准 props 里的输入动作面。
 * @returns 结果；失败时 error 已可直接展示（含 host 调用本身失败）；`ok:true` 且带
 *   `warning` 时表示内容已回弹、只有标记没生效。
 */
export async function performRestore(
  ctx: ClientCtx,
  sessionId: string,
  record: DraftRecord,
  inputActions: InputActionsLike,
): Promise<RestoreOutcome> {
  try {
    const got: InvokeResult = await hostCall('draft-get', { id: record.id })
    if (!got.ok || got.record === undefined) {
      return { ok: false, error: got.error ?? '读取草稿失败', missing: 0 }
    }
    const result = await restoreDraft(resolveComposer(ctx), sessionId, got.record, inputActions, got.assetUrls ?? {})
    // 走到这里正文已经在输入框里，「输入框装的是这条草稿」从此成立——记下来，等它被清空
    // （发送成功或手动清空）时由 active-draft 的协调器发出那一次复位请求。
    // 位置就在 restoreDraft 之后：它前面任何一条失败路径都不该有记录，它后面置 active 失败
    // 也撤不掉这个事实（那只影响列表徽标，正文与已被 draft-get 激活的元素集都还在）。
    noteRestored(record.id)
    // 只有成功回弹才置 active：失败时不能让列表标出一条其实没进输入框的草稿。
    // 走到这里正文已在输入框里，所以置 active 的失败不再走上面的 catch。
    const warning = await markActive(record.id)
    return warning === undefined
      ? { ok: true, missing: result.missing }
      : { ok: true, missing: result.missing, warning }
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message || err), missing: 0 }
  }
}

/**
 * 把回弹结果折成一句可直接展示的提示。
 *
 * 成功文案与 `warning` **同时在**（`；` 连接），谁都不吞谁——`warning` 说的是
 * 「内容已回弹、但标记没生效」，只报成功会让这件事无人知晓，只报警告又像失败了。
 *
 * 放在这里而不是组件里：两个入口（`DraftView` / `DraftStrip`）要拼的是同一条规则，
 * 而组件模块 import react（仓库只有 `@types/react`，Node 里加载不了）；这句拼接
 * 因此是本任务能在 Node 单测里钉住的提示行为，组件是否真的调它仍归 Task 10 验收。
 *
 * @param outcome - `performRestore` 的结果。
 * @param successText - 成功文案（调用方按 missing 决定措辞；空串表示这次不用提示）。
 * @returns 整句提示；空串表示本次不需要提示（两段都为空）。
 */
export function restoreNotice(outcome: RestoreOutcome, successText: string): string {
  if (!outcome.ok) return '回弹失败：' + (outcome.error ?? '未知错误')
  return [successText, outcome.warning ?? ''].filter((part) => part !== '').join('；')
}
