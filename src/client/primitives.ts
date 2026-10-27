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
 *
 * 但**窄化不等于假装某个导出一定在**：同一个字形在不同版本里换过名字（对勾图标
 * 0.1.5-rc.2 叫 `IconCheckOutline16`，当前版叫 `IconCheckOutlineRegular` / `…Medium`），
 * 而按名字取到一个 `undefined` 再交给 `h()` 会抛 React #130，把整块 slot 条目的内容
 * 一起带走。所以图标一律经 {@link resolveIcon} 解析并判空后再用——见那里的现场记录。
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
  /**
   * 语义色条（当前版平台：`tone === 'success'` 时**自带**成功对勾图标，并忽略 `icon`）。
   *
   * 优先用它而不是自己传图标：图标常量在各版本里换了名字，靠名字取组件会静默变
   * `undefined`，而 `h(undefined)` 会让整块 slot 崩掉（见 {@link resolveIcon}）。
   */
  tone?: 'success'
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

/**
 * 平台模块表面（只声明本插件读取的成员）。
 *
 * 图标**不在这里声明**：平台各版本给同一个字形的名字不同（实测当前版导出
 * `IconCheckOutlineRegular` / `IconCheckOutlineMedium`，而 0.1.5-rc.2 是
 * `IconCheckOutline16`），写死任何一个都会在另一版上取到 `undefined`。图标一律经
 * {@link resolveIcon} 按候选名解析。
 */
interface PrimitivesModule {
  Modal: ComponentType<ModalProps>
  Button: ComponentType<ButtonProps>
  Toast: ComponentType<ToastProps>
}

/** 平台的图标导出可能不存在（见 {@link PrimitivesModule} 的说明）。 */
type IconComponent = ComponentType<IconProps> | undefined

/**
 * 按候选名解析一个图标组件，全部缺失时返回 `undefined`。
 *
 * **返回值必须判空再渲染**：`h(undefined)` 会抛 React #130（"Element type is invalid"），
 * 而 slot 的错误边界会因此把**整个条目**卸掉——曾经的具体后果是：删除一条草稿后弹成功
 * toast，图标取成 `undefined` 把 `conversation.input.dock` 整块打崩，用户看到的是
 * 「删一条，整张草稿列表消失」，误以为删掉了全部草稿。
 *
 * @param names - 候选导出名，按优先级排列（新版名放前面）。
 * @returns 第一个存在的组件；一个都没有时为 `undefined`。
 */
function resolveIcon(...names: string[]): IconComponent {
  const table = Primitives as unknown as Record<string, unknown>
  for (const name of names) {
    const candidate = table[name]
    if (candidate !== undefined) return candidate as IconComponent
  }
  return undefined
}

/** 平台模块实例。 */
export const Primitives = require('@deepseek-ai/dsh-client-ui-primitives') as PrimitivesModule

/**
 * 成功态对勾图标：**可能为 `undefined`**（平台没有这个字形时）。
 *
 * 只给不支持 `tone` 的旧版平台兜底用；当前版由 `Toast` 的 `tone: 'success'` 自带图标。
 */
export const CheckIcon: IconComponent = resolveIcon(
  'IconCheckOutlineRegular',
  'IconCheckOutlineMedium',
  'IconCheckOutline16',
)
