/**
 * 「当前草稿」在输入框侧的协调器：把「内容进了输入框」与「输入框被清空」收成一条规则。
 *
 * 为什么需要它：host 侧有两件事必须一起消失——每条记录的 `active` 标志（列表里的「当前」
 * 徽标）与元素激活集（系统提示段里的 `[DOMn]` 清单）。两者的共同前提都是「composer 里正
 * 装着那条草稿的正文」，所以由 composer 的观测者发起那一次 `draft-set-active { id: null }`，
 * host 在一次调用里把两件一起做掉（见 `src/host/routes.ts`）。**一次调用、一个不变量**：
 * 分成两次请求迟早会漂移成「徽标清了、提示段还在列旧编号」。
 *
 * 判定标准的边界（有意划在这里，不是疏漏）：
 *   - 触发条件是输入框**变成**空的：回弹成功后记下 id，之后任何一次 composer 观测到
 *     「有记录 + 现在为空」就复位一次。
 *   - 它同时覆盖「发送成功」与「手动清空」两种局面，规则不区分、也不需要区分它们：
 *     无论正文去哪了，输入框里已经没有这条草稿了。
 *   - 它**不**在「用户改了草稿但没清空」时触发：徽标与元素集一直留到输入框真的空掉。
 *     这是有意的——编辑中的正文对应的仍是同一批 `[DOMn]`，提前清掉会让模型看不懂记号。
 *   - **不**单独探测「是否发送」：那需要订阅发送事件，而发送成功的直接可观测后果就是
 *     输入框变空；多一条探测路径只会多一处可能与事实不符的状态。
 *
 * 已知边界（本设计接受的代价）：清空是**边沿触发**的，只有两个 composer 观测者
 * （`DraftView` / `DraftStrip`）至少有一个挂载着、并因输入框变化重渲染时才会发出请求。
 * 两个都没挂载时（例如既不在草稿 tab、当前会话也没有 dock 列表）这条复位没人发起。
 * 观测者**观测不到**输入框时（槽位没提供可选 prop `useInput`）同样一律不动：观测不到不等于
 * 空，理由见 `noteComposerChange`——乱猜「空」会让刚回弹成功的元素集在下一次渲染就被清掉。
 *
 * 本模块刻意不认识 React：判定与状态因此能在 Node 单测里直接跑真身（仓库只装了
 * `@types/react`，没有 react 运行时）。两个组件只在渲染时各调一次 `noteComposerChange`。
 */

import { hostCall, logError, logInfo } from './host-call.ts'
import { hasComposerContent } from './composer-bridge.ts'

/**
 * 「内容正在输入框里」的那条草稿 id；`null` 表示没有。
 *
 * 模块级状态，但**不是 composer 的副本**（spec §2 否掉了镜像方案）：它只记住「回弹成功过、
 * 那次写入的正文仍在输入框里」这一个事实，与 composer 的真实内容无关。
 */
let activeDraftId: string | null = null

/**
 * 记下「这条草稿的内容现在在输入框里」。
 *
 * 只该在正文**确实**写进输入框之后调用（`performRestore` 的成功路径）。回弹失败却记下来，
 * 会让下一次输入框变空时去清一份根本不属于这条草稿的激活集——而那份激活集可能来自上一次
 * 真正成功的回弹。
 *
 * @param id - 回弹成功的那条草稿 id。
 */
export function noteRestored(id: string): void {
  activeDraftId = id
}

/**
 * 输入框现状变了：若此前有回弹记录、而输入框现在空了，发一次复位请求。
 *
 * 幂等，可任意频繁调用（两个组件每次渲染都会调）：没有记录时是纯空操作；**观测不到**输入框时
 * 同样是空操作；有记录而输入框非空时不发；发出复位后立刻清掉记录，于是后续每一次按键与重渲染
 * 都落在前三个分支上——**那本身就是「只发一次」的闸门**，不需要额外的时间窗或去重表。
 *
 * 为什么「观测不到」必须与「空」分开：两个入口的输入框现状来自**可选** prop `useInput`，槽位
 * 一旦没给（或 harness 改了 props 形状），组件每次渲染都只能报出一个空输入框。若把观测不到当
 * 成空，回弹成功、`draft-get` 刚把元素激活集填好的下一次渲染就会立刻发复位请求把它清掉——用户
 * 点一下「回弹」，`[DOMn]` 上下文当场消失。**观测不到不等于空**：猜「空」会毁掉 host 刚刚激活
 * 的上下文，而什么都不做的最坏后果只是徽标与元素集多留一会儿（边沿触发那条边界本来就允许延迟）。
 *
 * 「空」的判定复用 `hasComposerContent`（与保存按钮、回弹前覆盖确认同源，全仓库只有这一份
 * 定义）：只有附件也算有内容，所以「正文被删光但附件还在」不会被误判成空——那半条草稿还在
 * 输入框里，元素集与徽标就该留着。
 *
 * @param observation - 输入框现状（正文原样，可能全是空白；当前有序附件 id）；`undefined`
 *   表示**观测不到**输入框（槽位没提供 `useInput`），与「有内容」同属不动分支。
 */
export function noteComposerChange(
  observation: { draft: string; attachmentIds: readonly string[] } | undefined,
): void {
  const id = activeDraftId
  // 没有回弹记录就不动：用户只是还没开始打字，不能因为输入框空着就去清别人的激活集
  if (id === null) return
  // 观测不到就不动，**不**退化成「空」：这一条是回弹后元素集能不能活过下一次渲染的分界
  if (observation === undefined) return
  if (hasComposerContent(observation.draft, observation.attachmentIds)) return
  // 先摘记录、再发请求，顺序也是闸门的一部分：紧接着的下一次渲染不会再发第二遍
  activeDraftId = null
  logInfo('输入框已清空，复位当前草稿并清空元素激活集（草稿 ' + id + '）')
  void clearActive(id)
}

/**
 * 发一次 `draft-set-active { id: null }`：host 在一次调用里复位 `active` 标志并清空激活集。
 *
 * **不抛**（调用方在渲染路径上，是 fire-and-forget）：失败留一条带业务上下文的 ERROR 日志，
 * 但**不重试**——重试的唯一触发点是「下一次 composer 变化」，而那时输入框往往还是空的，
 * 等于在每次按键上重发同一条注定失败的请求。代价是复位可能一直不生效（徽标与提示段停在
 * 旧状态）直到下一次回弹或进程重启；那条 ERROR 是它唯一的出口，也正是「不许静默失败」的落点。
 *
 * @param id - 刚刚离开输入框的草稿 id，只用于日志上下文（请求体里的 id 是 null）。
 */
async function clearActive(id: string): Promise<void> {
  const context = '清空当前草稿标记失败（列表可能仍标着「当前」、提示段可能仍列着旧 [DOMn]）：' + id
  try {
    const res = await hostCall('draft-set-active', { id: null })
    if (res.ok) return
    logError(context, res.error)
  } catch (err) {
    logError(context, err)
  }
}

/**
 * 清空模块状态，仅供测试在用例之间隔离。生产代码不调用它。
 *
 * 用例共用同一个模块实例，`activeDraftId` 会跨用例残留；没有这个出口，一个用例记下的
 * 「已回弹」会让下一个用例的「空输入框」意外发出请求（假红），或者反过来被上一个用例
 * 摘掉记录（假绿）。
 */
export function resetActiveDraftForTest(): void {
  activeDraftId = null
}
