/**
 * 「保存到草稿」按钮：`conversation.input.left`（composer 工具行左侧的 list 槽位）。
 *
 * 行为要点：
 *   - **有内容才出现**：无文字且无附件时按钮不渲染，工具行上不留空位；但保存结果提示
 *     （含 host 的 `warnings`）不受这条规则约束——保存成功会清空输入框，提示若跟着按钮
 *     一起收掉就永远没人看得到；提示落下约 NOTICE_TTL_MS 后自动清空，届时整块从 DOM 收回
 *     （见渲染处的说明）；
 *   - 点击 = 采集输入框现状（正文 + 附件字节）→ `draft-save` → 就地提示结果，
 *     host 的 `warnings`（降级说明）逐条展示；
 *   - **保存成功就地清空输入框**（正文 + 附件）并通知两个草稿列表重拉，再落提示；
 *     失败时输入框一个字都不动（见 `onSave` 里的顺序说明）；
 *   - 提交面正忙或本次保存未落地时 `disabled`，避免连点存出两条一模一样的草稿。
 *
 * `ctx` 不在 props 里（props 由框架构造）：它经槽位注册的 `inject` 工厂摊进来，
 * 见 `index.ts` 的注册处。
 */

import { React, h } from './react'
import { hostCall, logError } from './host-call.ts'
import { clearComposer, hasComposerContent, resolveComposer, snapshotDraft } from './composer-bridge.ts'
import { bumpDraftRevision } from './draft-events.ts'
import type { SaveDraftButtonProps } from './services.ts'

/** 内联样式（按钮与提示排成一行）。 */
const S: Record<string, React.CSSProperties> = {
  wrap: { display: 'inline-flex', alignItems: 'center' },
}

/**
 * 提示的存活时长（毫秒）。
 *
 * 提示是保存成功后**唯一**的反馈（输入框已被清空），所以必须留够看清的时间；
 * 但它也不能永久占位——见下面清理用的 effect。
 */
const NOTICE_TTL_MS = 3500

/**
 * 保存图标：软盘轮廓（16×16、`currentColor`，随按钮文字色变化）。
 * client 半不引图标库，所以直接画路径。
 */
function saveIcon(): React.ReactNode {
  return h(
    'svg',
    { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', focusable: 'false' },
    h('path', {
      d: 'M3 2.5h7.3L13.5 5.7V13a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5Z',
      stroke: 'currentColor', strokeWidth: 1.2, strokeLinejoin: 'round',
    }),
    h('path', {
      d: 'M5.5 2.5v3.2h4V2.5M5.5 13.5V9.8h5v3.7',
      stroke: 'currentColor', strokeWidth: 1.2, strokeLinejoin: 'round',
    }),
  )
}

/**
 * 槽位组件。
 *
 * @param props - 框架注入的标准 props（`sessionId` / `useInput` / `inputActions`）
 *   加上 `inject` 工厂摊进来的 `ctx`。
 * @returns 按钮（含结果提示）；输入框为空且没有待展示的提示时返回 `null`。
 */
export function SaveDraftButton(props: SaveDraftButtonProps): unknown {
  const [saving, setSaving] = React.useState(false)
  const [notice, setNotice] = React.useState<readonly string[]>([])

  // 标准 props 的 selector 订阅：正文、有序附件 id、提交面阶段
  const draft = props.useInput ? props.useInput((state) => state.draft) : ''
  const attachmentIds = props.useInput ? props.useInput((state) => state.attachmentIds) : []
  const busyPhase = props.useInput ? props.useInput((state) => state.phase !== 'plain') : false

  // 提示不常驻：落下 NOTICE_TTL_MS 之后自动清掉自己。
  // 没有这一步，保存成功后那行字会连同 S.wrap 一直挂在工具行上（按钮已经没了、输入框也空了，
  // 本组件却因为 notice 非空而继续渲染），用户不碰保存按钮它就永不收回。清掉之后
  // notice 为空 + 输入框为空 → 下面的提前 return 生效，S.wrap 一并从 DOM 消失。
  // 用户在提示还在时就开始打字：按钮随输入回来，提示照旧到点消失，两者互不干扰
  // （依赖只有 notice，输入框变化不会重置这个计时）。
  //
  // **必须在下面那条提前 return 之前**：hooks 的调用顺序每次渲染都得一样，
  // 而那条 return 是否命中取决于「输入框空不空 + 有没有提示」——把它排到 effect 前面，
  // 会在「从有提示渲染到无提示渲染」的那一帧少调一个 hook，React 直接报错。
  React.useEffect(() => {
    if (notice.length === 0) return
    const timer = setTimeout(() => { setNotice([]) }, NOTICE_TTL_MS)
    // 清理必须挂上：下一次保存在开头就 setNotice([])，若旧定时器还在跑，
    // 它会在新提示落下几秒后把**新**提示误清掉（提前于这次的 TTL）
    return () => { clearTimeout(timer) }
  }, [notice])

  // 「有内容才出现」：空输入框（无文字、无附件）时不占位。
  //
  // **但保存结果提示不跟着收**：保存成功会清空输入框（见 onSave），本组件紧接着就落进
  // 这条分支，若连提示一起收掉，那一次保存的唯一反馈（host 的 warnings、降级附件说明）
  // 就永远进不了 DOM——实机用 MutationObserver 盯过：清空后再 setNotice 的那次渲染里
  // hasComposerContent 已是 false，提示一次都没被插入过，等于把降级说明静默吞掉。
  // 所以这里只收按钮、留提示：工具行上先留下「已保存到草稿」那几行（按钮消失），
  // 到点由上面的 effect 清掉，整块随之收回。
  const empty = !hasComposerContent(draft, attachmentIds)
  if (empty && notice.length === 0) return null

  /** 采集并提交一次保存；失败与降级都落在本地提示上，不冒泡成未捕获异常。 */
  const onSave = (): void => {
    setSaving(true)
    setNotice([])
    void (async () => {
      try {
        // resolveComposer 会在包内面缺失时同步抛错，所以整段包在 try 里
        const payload = await snapshotDraft(resolveComposer(props.ctx), props.sessionId, { draft, attachmentIds })
        const res = await hostCall('draft-save', { payload })
        if (!res.ok) {
          setNotice(['保存失败：' + (res.error || '未知错误')])
          return
        }
        // 顺序是行为的一部分：① 清空输入框（正文 + 附件，判定与清空同源），
        // ② 通知两个草稿列表重拉（保存按钮与它们在不同槽位、没有共同父组件，
        //   只能走 draft-events 的模块级版本号），③ 最后才落成功提示。
        // 失败路径在上面就 return 了：保存没落地时输入框一个字都不动，用户不会丢内容。
        clearComposer(props.inputActions ?? {}, attachmentIds)
        bumpDraftRevision()
        // warnings 逐条展示：降级附件的信息不能在 UI 上被合并成一句看不见的附注
        setNotice(['已保存到草稿', ...(res.warnings ?? [])])
      } catch (err) {
        logError('保存草稿失败', err)
        setNotice(['保存失败：' + String((err as Error)?.message || err)])
      } finally {
        setSaving(false)
      }
    })()
  }

  return h(
    'div',
    { style: S.wrap },
    // 输入框空着（保存刚清空）时只剩提示：按钮不再渲染，但那次保存的结果必须看得见
    empty ? null : h(
      'button',
      {
        className: 'dsh-pi-save',
        type: 'button',
        title: '保存到草稿',
        'aria-label': '保存到草稿',
        disabled: saving || busyPhase,
        onClick: onSave,
      },
      saveIcon(),
    ),
    notice.map((line, index) => h('div', { key: 'notice-' + index, className: 'dsh-pi-notice' }, line)),
  )
}
