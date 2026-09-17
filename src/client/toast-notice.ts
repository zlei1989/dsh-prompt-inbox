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
 * 组件本身加载不了（仓库只装了 `@types/react`，没有 react 运行时），因此渲染结果归
 * 浏览器验收；本文件里能在 Node 里跑的部分只有 `nextNotice` 的发号语义。
 */

import { h } from './react'
import { Primitives } from './primitives.ts'
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
 * 渲染一次提示；`notice` 为 `null` 时什么都不画。
 *
 * `key` 取 `seq`：同一句话连着来两次也会重新走一遍"停留 + 淡出"。
 */
export function ToastNotice(props: {
  notice: Notice | null
  /** 横幅横向居中的参照物；不传按视口居中。 */
  anchor?: HTMLElement | null
  onDone: () => void
}): ReactNode {
  if (props.notice === null) return null
  return h(Primitives.Toast, {
    key: props.notice.seq,
    text: props.notice.text,
    // 与宿主 FeedbackDialog 的成功提示同一个字形（平台把 .icon 统一染成提示色，
    // 不区分成功/警告，这里跟随平台，不自己调色）
    icon: h(Primitives.IconCheckOutline16, null),
    anchor: props.anchor ?? null,
    onDone: props.onDone,
  })
}
