/**
 * 「最近草稿」列表的显示范围判定（纯函数，Node 里可直接单测）。
 *
 * 只在新会话（hero）页显示，进入会话页后整块不渲染：会话页里草稿的常驻入口是
 * `conversation.view` 上的「草稿」tab，而那个 tab 在 hero 态**根本不挂载**
 * （实测 hero 页面 `[role=tab]` 为空）——两边都沉默就会出现「存了草稿却看不到」。
 * 换句话说：会话页有 tab，hero 才需要这个列表，两者互斥，不重复也不留空窗。
 *
 * 判定依据是会话视图快照的 `blank`，**不是 sessionId**：实机 fiber 探针显示 hero 态
 * 同样带着一个已定义的 sessionId（新会话页承载的就是那条还没有历史的 blank 会话），
 * 按「有 sessionId 就不显示」写会把列表在两种状态下一起隐藏，等于让它永不出现。
 * 依据与框架 `ConversationRoot` 的 hero 判定同源：`hero` 由 shellPhase（blank/engaging/
 * active，blank 由会话的 blank && !running && !awaitingFirstTurn 推出）与 openState 决定。
 *
 * `blank` 本身是**一等契约字段**（session-controller 的会话快照与 ui-conversation 的
 * `contract/snapshot.ts` 都声明 `readonly blank: boolean`；宿主用例写明它表示
 * 「conversation not started (no turn has run)」且「the first turn clears blank」；
 * ui-conversation 侧只降不升），所以拿它当「新会话页」的判据比 sessionId 可靠。
 *
 * 放在这里而不是组件里，是为了能在 Node 单测里跑真身：组件模块 import react，
 * 测试环境加载不了。用例名因此只说判定，不说「列表是否渲染」。
 */

import type { SessionSnapshotLike } from './services.ts'

/**
 * 当前是否处于「新会话（hero）」页。
 *
 * @param session - 槽位传入的会话视图快照（拿不到就是 undefined）。
 * @returns 该会话视图还没有任何历史（`blank === true`）时为 true。
 */
export function isNewSessionHero(session: SessionSnapshotLike | undefined): boolean {
  // 拿不到快照时返回 false：宁可少显（会话页里还有 tab 兜底），也不要在会话页误显一份
  return session?.blank === true
}
