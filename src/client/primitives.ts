/**
 * DSH 设计系统组件（平台模块）单点引入：`@deepseek-ai/dsh-client-ui-primitives`。
 *
 * 与 `react.ts` 同一套路——**只在这里 require 一次**，其余模块从这里导入，避免
 * 重复请求同一个平台模块。浏览器模块表（web shell 的 seed 表，见
 * `packages/client/web/src/platform.ts` 的 `PLATFORM_MODULES`）在运行时经注入的
 * `require` 回答这个包，所以这里**必须写动态 `require`**：
 *   · 动态 require 的目标不会被 tsup/esbuild 解析，因此既不会内联进来（该包
 *     `lib/index.js` 有 400+ KB），也不需要进 tsup 的 `external`（那里只放被静态
 *     `import` 的平台单例，例如 `react`）；
 *   · 产物判据因此是两条：`lib/client.js` 里出现该 require，且体积不膨胀。
 *
 * 类型是本插件自己窄化的（与 `services.ts` 同一策略）：本仓库没有安装这个包，
 * 从它 `import type` 会直接解析失败。运行时形状以 0.1.5-rc.2 为准——
 * `ui-primitives/src/Modal.tsx`、`Button.tsx`、`icons/index.tsx`。
 */

import type { ComponentType, ReactNode } from 'react'

/**
 * `Modal` 面。
 *
 * `closeLabel` 在这里**声明为必填**：平台的 `ModalProps` 只在 `headless: true`
 * 时把它放宽成 `never`，本插件用的都是有头模式（标题 + 关闭按钮），不给文案就
 * 少一个可访问性名称。
 */
export interface ModalProps {
  open: boolean
  /** Escape 或点击遮罩时回调（平台行为）。 */
  onClose: () => void
  /** 对话框标题；同时是 `aria-label`。 */
  title: string
  /** 关闭按钮的可访问性文案。 */
  closeLabel: string
  /** 标题下方的说明句。 */
  description?: string
  children?: ReactNode
  /** 底部动作行；平台的 `.footer` 已是右对齐 flex，直接放按钮即可。 */
  footer?: ReactNode
}

/** `Button` 面：只声明本插件用到的变体与属性。 */
export interface ButtonProps {
  variant?: 'primary' | 'ghost' | 'outline' | 'toolbar'
  size?: 'md' | 'sm'
  disabled?: boolean
  className?: string
  onClick?: () => void
  children?: ReactNode
}

/** 图标面：整个字形集都是 `{ size, className }` 且 `fill="currentColor"`。 */
export interface IconProps {
  size?: number
  className?: string
}

/**
 * `Toast` 面：平台自带的瞬时横幅（`ui-primitives/src/Toast.tsx`）。
 *
 * 它自己 `createPortal` 到 `document.body` 并带 `role="alert"`，所以调用方**放在哪都行**——
 * 不必挪到某个"能浮起来"的槽位（本插件也没注册 `frame.overlay`）。计时归它：先是
 * `holdMs`（默认 3000）的满不透明停留，再是 1000ms 淡出，淡完回调 `onDone`，由调用方卸载。
 * 于是**重新展示同一句话必须换一个 `key`**（用自增序号），否则 React 复用同一个实例、
 * 计时不会重来（`InputBar` / `FeedbackDialog` 都是这个做法）。
 */
export interface ToastProps {
  text: string
  icon?: ReactNode
  /**
   * 横幅横向居中对齐到哪个元素（平台传的是输入卡，让横幅压在对话列上而不是整窗中心）；
   * 不传就按视口居中。传 `useRef` 的元素时**帧内测不到**——首帧 ref 还没挂上，
   * 那时它按视口居中，下一帧量到就归位。
   */
  anchor?: HTMLElement | null
  holdMs?: number
  onDone: () => void
}

/** 平台模块表面（只声明本插件读取的成员）。 */
interface PrimitivesModule {
  Modal: ComponentType<ModalProps>
  Button: ComponentType<ButtonProps>
  Toast: ComponentType<ToastProps>
  IconTrashOutline16: ComponentType<IconProps>
  IconCheckOutline16: ComponentType<IconProps>
}

/** 平台模块实例。 */
export const Primitives = require('@deepseek-ai/dsh-client-ui-primitives') as PrimitivesModule
