/**
 * dsh-prompt-inbox — Client 半边（已安装包 bundle 入口）。
 *
 * 本模块是包的 `./client` bundle 主体：tsup（tsup.config.ts）把它打包成 CJS
 * （`react` 保持 external——浏览器模块表通过注入的 `require` 提供），并包裹在
 * web boot 握手 `window.__ModuleLoader__.load({ id, factory })` 里。
 *
 * 这里只做装配，不再承载实现：
 *   - 注入样式表（`installStyles`）；
 *   - 在 `conversation.input.left`（composer 工具行左侧的 list 槽位）注册
 *     「保存到草稿」按钮；
 *   - 在 `conversation.view` 注册「草稿」tab（`order: 20`，落在轨迹 `order: 10`
 *     右侧——对话 view 是 `order: 0`，见 ui-chat/ui-trajectory 的注册处）；
 *   - 在 `conversation.composer.dock` 注册「最近草稿」列表（`order: 0`），
 *     即渲染在整个输入框卡片**之下**（卡片内部的 input.dock 会让它出现在正文上方）。
 *
 * 骨架期的「收件箱」按钮（同槽位、同 order）已随 Task 8 删除：它调的 `inbox-ping`
 * 路由在 Task 5 就没了，留着会在工具行上多出一个点了报错的按钮。
 *
 * 日志：DEBUG 走 console.debug（DevTools 默认级别不可见，等价生产默认关闭）。
 */

import { PLUGIN_ID, logInfo } from './host-call.ts'
import { DraftStrip } from './DraftStrip.ts'
import { DraftView } from './DraftView.ts'
import { SaveDraftButton } from './SaveDraftButton.ts'
import { installStyles } from './styles.ts'
import type { ClientCtx } from './services.ts'

/**
 * 插件入口：注入样式表 + 注册三个槽位组件。
 * 全部经 ctx.effect 登记清理器，插件卸载（或热替换）时自动移除。
 */
function apply(ctx: ClientCtx): void {
  installStyles(ctx)

  // 槽位注册：先 inject 等槽位声明出现，再注册条目。
  // 三处同一个写法：`ctx` 不是框架 props，经注册项的 inject 工厂摊进组件（props.ctx）。
  // 下面的断言**不可省**，`inject` 也不能删——理由对三个槽位都成立。
  //
  // `conversation.input.left` 的声明
  // （ui-conversation 的 contract/slots.ts：`{ kind: 'list', scope: 'session' }`）
  // 不带 inject 面，于是 ui-slots 的**类型化** register 重载把 registrant 的 inject
  // 收成 `never` 而拒收它（组件的 props 类型同理，见 services.ts 的 SaveDraftButtonProps）。
  // 运行时并不拒——存进槽位表的是 `StoredEntry.inject`，其类型为
  // `(...args: never[]) => Record<string, unknown>`，对工厂本身没有约束
  // （ui-slots src/index.ts），框架照常把工厂返回值摊进 props。
  // 两种改法的后果不同，别搞混：
  //   · 只删断言 → 类型检查处报错（不是静默）；
  //   · 删掉 `inject`（或把它连同断言一起「简化」掉）→ 不报错，但 `ctx` 静默丢失，
  //     按钮/列表点下去只会报「Cannot read properties of undefined」。这才是真正的坑。
  ctx.effect(() => ctx.slots.inject('conversation.input.left', () => ctx.slots.register(
    {
      name: 'conversation.input.left',
      id: PLUGIN_ID + '-save',
      order: 0,
      inject: () => ({ ctx }),
    },
    SaveDraftButton as (props: Record<string, unknown>) => unknown,
  )))

  // 草稿 tab：`order: 20` > 轨迹的 10，落在轨迹右侧（对话 0 | 轨迹 10 | 草稿 20）。
  ctx.effect(() => ctx.slots.inject('conversation.view', () => ctx.slots.register(
    {
      name: 'conversation.view',
      id: PLUGIN_ID + '-drafts',
      order: 20,
      label: () => '草稿',
      inject: () => ({ ctx }),
    },
    DraftView as (props: Record<string, unknown>) => unknown,
  )))

  // 最近草稿列表：注册在 conversation.input.dock。
  //
  // 但**视觉上要落在输入框卡片之下**（用户要求）。为什么不用 conversation.composer.dock：
  // 已核实源码，那个槽位只在 `variant === 'composer' && input !== undefined && sessionId !== undefined`
  // 时才渲染（skeleton/InputBar.tsx 尾部），**hero 态根本不渲染**——而新会话页正是 hero 态，
  // 换过去会让列表整块消失（实测过）。
  //
  // hero 态里没有任何「卡片之后」的槽位：ConversationRoot 的 composerStack 顺序是
  // HeroShell → input.dock → inputBar，input.dock 就在卡片**之前**。
  // 所以这里保留唯一在两种状态下都渲染的槽位，用 CSS 的 `order` 把它排到卡片之后
  // （composerStack 是 flex 容器，见 styles.ts 里 .dsh-pi-strip 的 order: 1）。
  ctx.effect(() => ctx.slots.inject('conversation.input.dock', () => ctx.slots.register(
    {
      name: 'conversation.input.dock',
      id: PLUGIN_ID + '-strip',
      order: 0,
      inject: () => ({ ctx }),
    },
    DraftStrip as (props: Record<string, unknown>) => unknown,
  )))

  logInfo('client 半已加载（槽位 conversation.input.left / conversation.view / conversation.composer.dock）')
}

// loader 契约：bundle 外层包裹（tsup banner）提供局部 module/exports，
// 这里导出插件表面供 window.__ModuleLoader__ 读取。
module.exports = {
  name: PLUGIN_ID,
  inject: ['slots'],
  apply,
}
