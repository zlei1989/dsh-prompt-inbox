/**
 * client 半的样式。
 *
 * 集中一处、经 `installStyles(ctx)` 挂载：样式表是插件的一种副作用，必须走
 * `ctx.effect` 登记清理器，随插件卸载（或热替换）一起移除——否则反复加载会在
 * `<head>` 里叠出一堆同名样式标签。
 *
 * **配色只走设计系统的语义 token（`--dsw-alias-*`）**：token 自带浅深色两套值，
 * 插件表面因此跟随页面主题，不再是一块固定深色的岛（骨架期那一套写死的深色值
 * 只在深色主题下成立，而实测页面默认是浅色）。本文件里出现字面色值即为缺陷——
 * 判据是「十六进制色值或函数式颜色写法的检索结果为空」，所以连注释里也不留色值示例。
 * 两个 token 表达不了的悬停/禁用底色用 `color-mix(in srgb, currentColor …)`，
 * 它是相对当前文字色算的，天然两套主题都成立。
 *
 * 回弹/删除的确认面板已改用平台 Modal（见 `confirm-dialogs.ts`），因此原先的
 * `.dsh-pi-confirm` 一并删除——面板的配色归平台组件，不再由本文件负责。
 *
 * **宽度也只走宿主已发布的那几条轴**（`--dsh-chat-content-width` 等），两条界面各自
 * 照抄一个同槽位的邻居：草稿 tab 照抄 `ui-chat` 的消息列 `.column`（宽度与居中），
 * 最近草稿列表照抄 `ui-conversation` 同栈的 TodoPanel（见下）。插件不发明宽度数值，
 * 否则宿主改一次宽度轴、两个界面就与邻居错开一截。
 */

import { PLUGIN_ID } from './host-call.ts'
import type { ClientCtx } from './services.ts'

/** 全部插件样式（一条字符串，宿主只注入一个 `<style>` 标签）。 */
export const STYLE_CSS =
  '.dsh-pi-save { background: transparent; border: 1px solid transparent; color: var(--dsw-alias-label-secondary); line-height: 1; padding: 6px; border-radius: 6px; cursor: pointer; font-family: inherit; display: inline-flex; align-items: center; }'
  + '.dsh-pi-save:hover { background: color-mix(in srgb, currentColor 8%, transparent); color: var(--dsw-alias-label-primary); }'
  + '.dsh-pi-save:disabled { opacity: 0.45; cursor: default; }'
  + '.dsh-pi-notice { color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 1.5; margin-left: 6px; }'
  + '.dsh-pi-title { color: var(--dsw-alias-label-primary); font-size: 13px; font-weight: 600; margin-bottom: 6px; }'
  + '.dsh-pi-actions { display: flex; gap: 8px; margin-top: 10px; }'
  + '.dsh-pi-btn { background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-primary); font-size: 12px; padding: 4px 10px; border-radius: 6px; cursor: pointer; font-family: inherit; }'
  + '.dsh-pi-btn:hover { background: color-mix(in srgb, currentColor 8%, var(--dsw-alias-bg-layer-2)); }'
  + '.dsh-pi-btn:disabled { opacity: 0.5; cursor: default; }'
  // 删除确认按钮：破坏性动作走错误色（平台 Button 的 outline 变体外加这一层色）
  + '.dsh-pi-danger { color: var(--dsw-alias-state-error-primary); }'
  // ---- 草稿 tab（DraftView）
  //
  // 宽度走**对话列那条宽度轴**，本插件不自造数值：`.viewArea` 两轴都是
  // `pad: 0 / max-width: none`，不设宽度时本面板会横铺满整个视图区（实测 1238px），
  // 与 `对话` tab 的消息列（实测 798.7px，居中）对不上——切 tab 时整块内容会横向跳一下。
  // `--dsh-chat-content-width` 由 ConversationRoot 的 `.root` 定义、沿 DOM 继承到这里
  // （本面板是 `.viewArea` 的后代，实测解析值 798.72px 与消息列相同），是全栏唯一的内容宽度：
  // 消息列 `.column` 是 `max-width: 该值` + `margin: 0 auto`，dock 卡片是它减四个 inset，
  // 输入卡是它加 32。本面板照抄消息列那一种写法，于是**卡片与对话里的消息逐像素对齐**（实机已核）。
  //
  // 上下 16px 是 `.pnUQgG_scroll`（ChatView 的滚动容器）的内边距，消息列正是靠它离视图区
  // 顶部 16px；`.viewArea` 自己没有内边距，本面板不自带这一条就会比对话高 16px 顶格。
  // 左右不加内边距：聊天滚动的 32px 是**滚动容器**的，本面板自己不滚（滚动归 `.viewArea`），
  // 照抄会把卡片缩进聊天文字 32px，反而不是「对齐」。
  //
  // `box-sizing` 必须显式写：全站没有 `* { box-sizing }` 重置，留成 content-box 的话
  // 内边距会加在 `max-width` 之外，卡片比消息列宽 32px。
  // 每个 `var()` 都带兜底：变量没继承到时（宿主改结构、本面板被挪出会话栏）整条
  // `max-width` 会失效退回 auto，那时宽度仍是占满——可接受的降级，而不是塌成内容宽。
  //
  // 曾怀疑有 5px 残差（`.scrollBody` 有 `margin-right: 2px`、且无条件预留了 8px 滚动条槽），
  // 实机复测不成立：滚动条槽占掉的是**滚动容器的 padding box**（clientWidth 1238 = 视图区宽度），
  // `.column` 的 `margin: 0 auto` 因此正好落在它与视图区共同的中心（899）。两个 tab 实测同为
  // left 499.6 / width 798.7，逐像素相等——所以这里**不要**加任何补偿。
  + '.dsh-pi-view { box-sizing: border-box; color: var(--dsw-alias-label-primary); font-size: 12px; padding: 16px 0; width: 100%; margin: 0 auto; max-width: var(--dsh-chat-content-width, 100%); }'
  + '.dsh-pi-view-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }'
  + '.dsh-pi-toggle { display: inline-flex; align-items: center; gap: 4px; color: var(--dsw-alias-label-secondary); font-size: 11px; cursor: pointer; }'
  + '.dsh-pi-empty { color: var(--dsw-alias-label-secondary); font-size: 12px; padding: 10px 0; }'
  // ---- 草稿卡片（DraftCard，两个界面共用）
  //
  // 这一组是**卡片本身**的唯一样式来源：草稿 tab 与最近草稿列表都画同一份 DOM
  // （见 DraftCard.ts），不是各画一套再对齐。几何值来自实机读数（3088 实例的
  // 草稿 tab 卡片）：浅色主题下 1px 边框解析为 rgba(0,0,0,0.1)、底色 rgb(255,255,255)
  // 即 `--dsw-alias-border-l2` / `--dsw-alias-bg-layer-2`（浅深两套由 token 自带），
  // 圆角 8px、内边距 8px 10px、底距 8px。
  //
  // **`font-size` 必须写死在卡片上**，不能靠继承：两个界面挂在不同槽位，环境字号本来就
  // 不一样——草稿 tab 的祖先是 `.dsh-pi-view`（12px），而列表挂在 hero 的输入卡下面，
  // 那里解析出来是 16px。实测漏掉这一条时列表正文是 16px、tab 里是 12px，同一张卡片
  // 两处不一样大（且 16px 会把折叠行撑高）。
  + '.dsh-pi-item { background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; padding: 8px 10px; margin-bottom: 8px; font-size: 12px; }'
  // 「当前草稿」用品牌色描边：同一边框 token 下这条只能靠颜色区分
  + '.dsh-pi-item-active { border-color: var(--dsw-alias-brand-primary); }'
  // 折叠形态（最近草稿列表的默认态）：卡片只剩一行正文，**但保留内边距**——去掉它
  // 正文会贴着卡片边框，与展开态那张卡片不像同一个东西。纵向取 4px（展开态是 8px）：
  // 折叠行本来就该更紧凑，同时让"点开"只是长高、不跳位。
  // 底距归零：折叠时的垂直节奏由 `.dsh-pi-strip` 的 `gap` 管（那里也是 2px），
  // 卡片自己再带 8px 就会与它叠成双层间距、比展开态卡片之间的间隔还大。
  // **`box-sizing` 必须显式写**：正文节点是个 `<button>`，全站没有 `* { box-sizing }` 重置，
  // 留成 content-box 会让内边距与边框长在宽度之外，比 `.dsh-pi-strip` 算好的宽度多出一截。
  + '.dsh-pi-item-flat { display: flex; align-items: center; gap: 6px; padding: 4px 10px; margin-bottom: 0; min-width: 0; box-sizing: border-box; }'
  // `min-width: 0` 是**必需**的（不是保险）：本行是卡片这个 flex 列里的条目，默认
  // `min-width: auto` 会让它按正文的 max-content 撑开——正文一长，整张卡片就顶破
  // `.dsh-pi-strip` 的宽度，被列表的 `overflow: hidden` 从右边切掉，而正文那个
  // `text-overflow: ellipsis` 因为永远不"溢出自己的盒子"而一次都不生效。
  + '.dsh-pi-item-head { display: flex; align-items: center; gap: 6px; min-width: 0; }'
  // 展开态是 span、折叠态是 button（草稿 tab 与展开后的列表都走前者）。
  // 折叠态必须把按钮的默认外观整体抹掉，否则底色/边框/字体/居中都与卡片不是一套：
  // `font: inherit` 连字号行高一起继承，`color: inherit` 接住 `.dsh-pi-view` 的正文色。
  + '.dsh-pi-item-text { flex: 1; min-width: 0; color: var(--dsw-alias-label-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }'
  + '.dsh-pi-item-flat .dsh-pi-item-text { background: transparent; border: 0; padding: 0; font: inherit; color: inherit; text-align: left; cursor: pointer; }'
  // 键盘焦点可见：outline 的色用 currentColor 混出来，两套主题都够对比度
  // （偏移为 0：卡片已有 1px 边框，再外扩会和相邻行贴到一起）
  + '.dsh-pi-item-flat .dsh-pi-item-text:focus-visible { outline: 2px solid color-mix(in srgb, currentColor 45%, transparent); outline-offset: 0; }'
  + '.dsh-pi-item-meta { color: var(--dsw-alias-label-secondary); font-size: 11px; margin-top: 4px; }'
  + '.dsh-pi-badge { color: var(--dsw-alias-label-secondary); border: 1px solid var(--dsw-alias-border-l2); border-radius: 999px; padding: 0 6px; font-size: 10px; line-height: 16px; white-space: nowrap; }'
  // ---- 最近草稿列表（DraftStrip）
  // `order: 1` 是**位置**要求，不是微调：本列表注册在 conversation.input.dock，而
  // ConversationRoot 的 composerStack 顺序是 HeroShell → input.dock → inputBar，
  // 即 dock 在卡片**之前**。hero 态又没有「卡片之后」的槽位可用（composer.dock 只在
  // composer 变体渲染），所以用 flex `order` 把它排到卡片之后。
  // 本列表只在 hero 态渲染（见 DraftStrip 文件头），`order` 因此只服务那一种状态。
  //
  // 宽度/定位**逐条照抄同一个 composerStack 里的 TodoPanel**（ui-conversation
  // `skeleton/TodoPanel.module.css` 的 `.root`）：它与本列表同在 dock 槽位、同一条
  // 宽度轴，是可对照的邻居。不自己发明数值——`--dsh-composer-side-clearance`（16px）
  // 与 `--dsh-composer-dock-inset`（8px）由栈的祖先 ConversationRoot.module.css 定义，
  // 本列表在同一个栈里因此**继承**得到（实机已核实解析值）。每个 `var()` 都带兜底：
  // `calc()` 里出现未定义变量会让整条声明失效、宽度退回 auto，届时 flex 交叉轴上的
  // `margin: 0 auto` 会让盒子缩成内容宽（比栈里其他面板窄一截），兜底值就是防这个。
  //
  // 没有 `margin-top`：垂直节奏归 composerStack 的 `gap`（base 是
  // `var(--dsh-composer-stack-gap)` 的 6px，hero 态——本列表唯一渲染的状态——由
  // `.composerHero` 覆写成 8px），TodoPanel 也只有 `margin: 0 auto` 这一条。
  // 原先那个 `margin-top: 6px` 是叠在 gap 之上的第二个数字，会让本列表与卡片之间的
  // 间距比栈里相邻面板的关系多出 6px（实机实测：去掉后卡片→列表正好等于 hero 栈的 gap）。
  //
  // 条目间距 `gap` 取 2px 而不是 4px：折叠卡片自己带 4px 纵向内边距（见 `.dsh-pi-item-flat`），
  // 两张卡片之间因此是 4 + 2 + 4 = 10px 的视觉间隔，与**展开态卡片之间**的观感一致；
  // 留成 4px 会让折叠列表看起来比展开时更松散（同一个列表两种松紧）。
  + '.dsh-pi-strip { order: 1; display: flex; flex-direction: column; gap: 2px; box-sizing: border-box; flex: none; overflow: hidden; margin: 0 auto;'
  + 'width: calc(100% - var(--dsh-composer-side-clearance, 16px) - var(--dsh-composer-side-clearance, 16px) - var(--dsh-composer-dock-inset, 8px) - var(--dsh-composer-dock-inset, 8px) - var(--dsh-composer-dock-inset, 8px) - var(--dsh-composer-dock-inset, 8px));'
  + 'max-width: calc(var(--dsh-composer-card-max-width, 100%) - var(--dsh-composer-dock-inset, 8px) - var(--dsh-composer-dock-inset, 8px) - var(--dsh-composer-dock-inset, 8px) - var(--dsh-composer-dock-inset, 8px)); }'
  + '.dsh-pi-strip-head { color: var(--dsw-alias-label-secondary); font-size: 11px; }'
  // 列表里的每一条是 `DraftCard`（折叠形态 `.dsh-pi-item-flat`），样式归上面那组共用规则。
  // 原先这里有一整套行内样式（`.dsh-pi-strip-row` / `-main` / `-text` / `-del`），
  // 它们与 tab 的卡片各说各话，同一件事有两个事实源——现已随复用一并删除。

/**
 * 把样式表挂进 `document.head`，并登记卸载时的移除。
 *
 * @param ctx - client 上下文（用它的 effect 作用域）。
 */
export function installStyles(ctx: ClientCtx): void {
  ctx.effect(function () {
    let tag: HTMLStyleElement | null = null
    if (typeof document !== 'undefined') {
      tag = document.createElement('style')
      tag.dataset.plugin = PLUGIN_ID
      tag.textContent = STYLE_CSS
      document.head.appendChild(tag)
    }
    return function () {
      if (tag && tag.parentNode) tag.parentNode.removeChild(tag)
    }
  }, PLUGIN_ID + ': styles')
}
