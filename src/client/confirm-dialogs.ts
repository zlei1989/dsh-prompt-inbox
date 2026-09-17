/**
 * 两个确认对话框：回弹覆盖确认与删除确认。
 *
 * 草稿 tab（`DraftView`）与「最近草稿」列表（`DraftStrip`）各自都有这两个动作，
 * 对话框收在这里，文案与动作顺序就只有一份——两边各写一遍迟早会漂移。
 *
 * 用平台模块的 `Modal` + `Button`（`primitives.ts` 单点 require），不再自绘面板：
 * 自绘的深色面板在浅色主题下是一块黑岛，平台的 Modal 自带遮罩、圆角、阴影、
 * Escape 与 `role="dialog"`，且配色全部走 `--dsw-alias-*`，浅深色自动跟随。
 *
 * 「要不要先确认覆盖」的判定**不在这里**——仍然是 `restore-action.ts` 的
 * `shouldConfirmOverwrite`（纯函数、两个入口共用）。本模块只负责把决定的文案画出来。
 * 组件本身加载不了（仓库只装了 `@types/react`，没有 react 运行时），因此这里的一切
 * 归浏览器验收，不在 Node 单测里断言。
 */

import type { ReactElement } from 'react'
import { React, h } from './react'
import { Primitives } from './primitives.ts'

/** 两个对话框共用的受控参数。 */
export interface ConfirmDialogProps {
  open: boolean
  /** 取消（也是关闭按钮与 Escape 的出口：取消永远不产生副作用）。 */
  onCancel: () => void
  onConfirm: () => void
  /** 动作进行中：禁用两个按钮，避免重复触发同一次写盘。 */
  disabled?: boolean
}

/**
 * 回弹覆盖确认：正文与按钮文案是用户已确认过的那份，两个入口逐字一致。
 *
 * 返回类型写成 `ReactElement | null`（不是 `unknown`）：平台的 Modal 在 `open === false`
 * 时返回 null，而这个签名正好是 React 函数组件的形状——调用方能用 `h(...)` 直接挂载，
 * 不必再断言。
 */
export function RestoreConfirmDialog(props: ConfirmDialogProps): ReactElement | null {
  return h(Primitives.Modal, {
    open: props.open,
    // 关闭按钮/Escape/点遮罩都等价于取消：回弹是「确认才发生」的动作
    onClose: props.onCancel,
    title: '回弹草稿？',
    // 关闭按钮的可访问名走「关闭」而不是「取消」：取消是下面那个按钮的文案，
    // 两个控件同名会让读屏用户分不清（框架的删除对话框也用 closeLabel=关闭）
    closeLabel: '关闭',
    description: '回弹会覆盖输入框里现有的内容，继续？',
    footer: h(
      React.Fragment,
      null,
      h(Primitives.Button, { variant: 'outline', disabled: props.disabled === true, onClick: props.onCancel }, '取消'),
      h(Primitives.Button, { variant: 'primary', disabled: props.disabled === true, onClick: props.onConfirm }, '确认覆盖'),
    ),
  })
}

/** 删除确认：说清丢的是什么，删除按钮走错误色（破坏性动作的框架既有做法）。 */
export function DeleteConfirmDialog(props: ConfirmDialogProps): ReactElement | null {
  return h(Primitives.Modal, {
    open: props.open,
    onClose: props.onCancel,
    title: '删除这条草稿？',
    closeLabel: '关闭',
    // 草稿是磁盘上的唯一副本：正文、附件字节与元素快照都随它一起回收，不可恢复
    description: '正文、附件与元素快照都会从草稿箱移除，删除后无法找回。',
    footer: h(
      React.Fragment,
      null,
      h(Primitives.Button, { variant: 'outline', disabled: props.disabled === true, onClick: props.onCancel }, '取消'),
      h(
        Primitives.Button,
        { variant: 'outline', className: 'dsh-pi-danger', disabled: props.disabled === true, onClick: props.onConfirm },
        '删除',
      ),
    ),
  })
}
