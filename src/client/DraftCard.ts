/**
 * 草稿卡片：一条草稿记录的**唯一**呈现方式，草稿 tab（`DraftView`）与最近草稿列表
 * （`DraftStrip`）共用。
 *
 * 为什么要共用：两处原先各画一套，同一件事有了两套 DOM 与两套类名——列表那套是
 * 紧凑行（`.dsh-pi-strip-row` / `-main` / `-text` / `-del`），tab 那套是卡片
 * （`.dsh-pi-item*`）。于是「卡片长什么样」有两个事实源，改一处另一处不动。
 * 现在卡片归本文件，两个界面只负责外壳（标题、提示、确认对话框）与数据。
 *
 * **以草稿 tab 的卡片为基准**（`.dsh-pi-item*` 那组类与几何值一个字没改，实机已核），
 * 列表改成它的折叠形态，而不是反过来把 tab 压成紧凑行：展开后的列表行与 tab 里的卡片
 * 是同一个 DOM——正文、徽标、元信息、两个文字按钮（`回弹` / `删除`）逐项相同。
 *
 * 两种形态：
 *   · `collapsible: false` —— 恒定展开（草稿 tab）。正文是 `span`。
 *   · `collapsible: true`  —— 默认单行（列表）。正文是 `button`，整行可点，点开即
 *     露出全部内容。
 *
 * 两处刻意的选择：
 *
 * 1. **正文字符数不设上限**。「超出范围用省略号」交给 CSS `text-overflow: ellipsis`
 *    按真实可用宽度裁决，而不是 `previewLine` 预切：列表宽度受输入卡约束，写死的字符数
 *    只会抢在 CSS 前面切——实测 60 字上限在 798px 宽的列表里离溢出还差得远，于是省略号
 *    根本不是"超出范围"的结果，展开后也补不回被砍掉的字。因此卡片正文走 `flattenLine`
 *    （只折叠空白、不截断），截断长度交给宽度。`previewLine` 仍用于 `aria-label` 与
 *    `title` 这类不能塞整篇正文的属性。
 *
 * 2. **回弹只由按钮触发**。折叠时整行是「展开」按钮，不是回弹按钮——在列表里点一下
 *    不该发生覆盖输入框这种事；展开后正文变回 `span`、根部按钮随之消失，因此不会
 *    出现两个「回弹」按钮，也不会多一个同名 Tab 停靠点。
 */

import { React, h } from './react'
import { flattenLine, previewLine, sessionBadge, summarize } from './draft-record.ts'
import type { ReactNode } from 'react'
import type { DraftRecord } from '../shared/types.ts'

/** 卡片 props：只描述「这一条怎么画、点了做什么」，数据与对话框都归调用方。 */
export interface DraftCardProps {
  /** 这一条草稿记录。 */
  record: DraftRecord
  /** 当前会话 id：徽标要靠它判断这条草稿是不是来自别的会话。 */
  currentSessionId: string
  /** 忙（回弹/删除进行中）：动作按钮一律置灰，避免重复提交。 */
  busy: boolean
  /**
   * 回弹能力不可用（槽位没给 `inputActions`）。
   *
   * 与 `busy` 分开而不是合并成一个 `disabled`：两者原因不同，将来要分开展示也有余地；
   * 合并后调用点得先算一个布尔再传，判定就从「能力缺失」变成「能力缺失或忙」。
   */
  restoreDisabled: boolean
  /** 点「回弹」。 */
  onRestore: () => void
  /** 点「删除」（确认对话框由调用方弹）。 */
  onDelete: () => void
  /** 折叠形态：默认只画一行，点开才展开（最近草稿列表）。 */
  collapsible: boolean
}

/** 相对时间：只做到「刚刚 / N 分钟前 / N 小时前 / N 天前」，够用即可。 */
function relativeTime(at: number): string {
  const delta = Date.now() - at
  if (delta < 60_000) return '刚刚'
  if (delta < 3_600_000) return Math.floor(delta / 60_000) + ' 分钟前'
  if (delta < 86_400_000) return Math.floor(delta / 3_600_000) + ' 小时前'
  return Math.floor(delta / 86_400_000) + ' 天前'
}

/**
 * 一条草稿卡片（折叠形态见文件头）。
 *
 * 返回类型是 `ReactNode` 而不是别的组件那种 `unknown`：本组件会被**当成组件**传给
 * `h(DraftCard, …)`（草稿 tab 与列表都这么用），而 `createElement` 要求组件返回
 * 可渲染节点——`unknown` 会在这里直接类型报错。
 */
export function DraftCard(props: DraftCardProps): ReactNode {
  const { record, collapsible } = props
  // 摘要对「只有文字」的草稿返回空串，直接拼会渲染出前导的 ' · '；空串时只显示时间
  const summary = summarize(record)
  const badge = sessionBadge(record, props.currentSessionId)
  // 正文不截断（见文件头）：只折叠空白，长度由 CSS 按可用宽度裁决
  const text = flattenLine(record.content.text)
  // 提示语另按字符数收短：它进的是属性，不该塞整篇正文
  const hint = previewLine(record.content.text)
  // 折叠态自持：点开是**单向**的，不提供收起——收起会让「回弹/删除」在眼前消失，
  // 而列表本来就只在新会话页出现（见 DraftStrip 文件头），换页时整块卸载、自然重置。
  const [open, setOpen] = React.useState(false)
  const expanded = !collapsible || open

  // 正文节点：折叠态是按钮（整行可点、有可访问名）；展开态是纯 span——回弹由下面
  // `.dsh-pi-actions` 里那个按钮负责，这里再挂一个同名按钮就重复了
  const body = expanded
    ? h('span', { className: 'dsh-pi-item-text' }, text)
    : h(
        'button',
        {
          type: 'button',
          className: 'dsh-pi-item-text',
          // 读屏要知道这是个可展开的东西，以及它当前是收起状态（展开后本按钮消失，
          // 因此这里恒为 false，不会出现过期的展开态）
          'aria-expanded': false,
          // 正文可能被省略号截住，悬停给出收短后的一行预览
          title: hint,
          onClick: () => { setOpen(true) },
        },
        text,
      )

  return h(
    'div',
    {
      className: 'dsh-pi-item'
        + (record.active ? ' dsh-pi-item-active' : '')
        + (expanded ? '' : ' dsh-pi-item-flat'),
    },
    h('div', { className: 'dsh-pi-item-head' },
      body,
      // 徽标只在展开态出现：折叠态按约定只保留第一行正文
      expanded && record.active ? h('span', { className: 'dsh-pi-badge' }, '当前') : null,
      expanded && badge !== undefined ? h('span', { className: 'dsh-pi-badge' }, badge) : null,
    ),
    expanded
      ? h('div', { className: 'dsh-pi-item-meta' },
          (summary === '' ? '' : summary + ' · ') + relativeTime(record.createdAt))
      : null,
    // 动作行只在展开态渲染：折叠时列表里一行都不该有可点的破坏性动作
    expanded
      ? h('div', { className: 'dsh-pi-actions' },
          h('button', {
            className: 'dsh-pi-btn',
            type: 'button',
            disabled: props.busy || props.restoreDisabled,
            onClick: props.onRestore,
          }, '回弹'),
          // 删除必须先过确认对话框（调用方弹）：草稿是磁盘上的唯一副本，误点一次就找不回来
          h('button', {
            className: 'dsh-pi-btn',
            type: 'button',
            disabled: props.busy,
            onClick: props.onDelete,
          }, '删除'),
        )
      : null,
  )
}
