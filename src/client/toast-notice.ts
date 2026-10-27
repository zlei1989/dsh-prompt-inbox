/**
 * 瞬时提示（toast）：成功类反馈的统一出口，两个界面共用。
 *
 * 走平台的 `Toast`（`primitives.ts` 单点 require）：它自己 portal 到 `document.body`、
 * 带 `role="alert"`、`holdMs` 满不透明停留 + 1000ms 淡出后回调 `onDone`，配色走
 * `--dsw-alias-*`。**宽度与位置因此不归本插件管**，也不必为了"浮起来"去注册
 * `frame.overlay`。
 *
 * 与本插件原来那套行内 `.dsh-pi-notice` 的分工（与宿主 `ui-conversation` 的约定一致：
 * 瞬时错误走 Toast、常驻信息走行内 `notice`）：
 *   · **toast**：动作成功这类"看一眼就走"的反馈——删除成功、回弹成功；
 *   · **行内提示**：需要留在原地供人对照的错误——读取列表失败、删除失败、
 *     回弹警告（这些挂在各自的列表上，用户抬头就能看到是哪一条出的问题）。
 *
 * 重新展示**同一句话**必须换 `key`：`Toast` 的计时挂在 effect 上，React 复用同一个实例
 * 就不会重新计时（`InputBar` / `FeedbackDialog` 都靠自增 seq 解决）。所以这里把「一次提示」
 * 建模成 `{ seq, text }`，`nextNotice` 负责发号。
 *
 * **任何一环都不许把 `undefined` 当组件渲染**：平台对 slot 条目的处置是整条卸载，一次
 * 成功的删除弹不出横幅会把整张草稿列表一起带走（用户看到的是「删一条、全没了」）。所以
 * 图标改为按候选名解析（`primitives.ts` 的 `resolveIcon`），并且横幅外面包一层只罩住它的
 * 错误边界——提示丢了可以接受，列表丢了不行。
 *
 * 组件本身加载不了（仓库只装了 `@types/react`，没有 react 运行时），因此渲染结果归
 * 浏览器验收；本文件里能在 Node 里跑的部分只有 `nextNotice` 的发号语义。
 */

import { React, h } from './react'
import { CheckIcon, Primitives } from './primitives.ts'
import { logError } from './host-call.ts'
import type { ReactNode } from 'react'

/** 一次待展示的提示：`seq` 只用于给 `Toast` 换 key，不参与展示。 */
export interface Notice {
  readonly seq: number
  readonly text: string
}

/** 发号器：同一个模块实例内递增即可，只要求"每次展示都不一样"。 */
let noticeSeq = 0

/**
 * 造一次提示。
 *
 * @param text - 展示文案（空串表示不展示，调用方直接传 `null` 更清楚）。
 * @returns 带新 `seq` 的提示。
 */
export function nextNotice(text: string): Notice {
  noticeSeq += 1
  return { seq: noticeSeq, text }
}

/**
 * 横幅本体的渲染：单独一个组件，**为的是让下面那条错误边界罩得住它**。
 *
 * 若把 `h(Primitives.Toast, …)` 写在 `ToastNotice` 里，取组件这一步（`Primitives.Toast`
 * 为 `undefined` 时 `h` 直接抛 #130）发生在边界的**上层**，边界根本接不到；放进子组件后，
 * 抛错发生在子组件渲染期间，边界才能兜住。
 */
function ToastBody(props: {
  notice: Notice
  anchor: HTMLElement | null
  onDone: () => void
}): ReactNode {
  return h(Primitives.Toast, {
    text: props.notice.text,
    // 语义色条由平台给（当前版 `tone: 'success'` 自带对勾），不自己传图标：
    // 图标常量跨版本改过名，按名字取组件可能拿到 undefined（见 primitives.ts 的 resolveIcon）
    tone: 'success',
    // 旧版平台不认 `tone`，只认 `icon`：解析到才传，解析不到就不传。
    // **绝不能传 undefined**——那会让 React 抛 #130、整块 slot 被错误边界卸掉，
    // 于是「删除成功」这条装饰性反馈反而把整个草稿列表带走（真实故障，见 resolveIcon）
    ...(CheckIcon === undefined ? {} : { icon: h(CheckIcon, null) }),
    anchor: props.anchor,
    onDone: props.onDone,
  })
}

/**
 * 只罩住横幅的错误边界：**提示是装饰，列表是数据，装饰的失败不许带走数据**。
 *
 * 平台对 slot 条目的处理是整条卸载（控制台里那句「slot entry crashed in …」），
 * 所以这里不再往上抛：横幅渲不出来就少一条提示，列表照常显示。
 */
class ToastBoundary extends React.Component<{ children?: ReactNode }, { failed: boolean }> {
  state: { failed: boolean } = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  componentDidCatch(err: unknown): void {
    logError('提示横幅渲染失败（已跳过本条提示，列表不受影响）', err)
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children
  }
}

/**
 * 渲染一次提示；`notice` 为 `null` 时什么都不画。
 *
 * `key` 取 `seq`：同一句话连着来两次也会重新走一遍"停留 + 淡出"；边界也按 `seq` 换实例，
 * 免得一次失败把后续所有提示一起挡掉（React 的错误边界一旦进入 failed 就不会自己复位）。
 */
export function ToastNotice(props: {
  notice: Notice | null
  /** 横幅横向居中的参照物；不传按视口居中。 */
  anchor?: HTMLElement | null
  onDone: () => void
}): ReactNode {
  const notice = props.notice
  if (notice === null) return null
  return h(
    ToastBoundary,
    { key: notice.seq },
    h(ToastBody, { notice, anchor: props.anchor ?? null, onDone: props.onDone }),
  )
}
