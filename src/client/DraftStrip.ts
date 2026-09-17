/**
 * 最近草稿列表：挂在 `conversation.input.dock`，即渲染在整个输入框卡片**之下**。
 *
 * 本文件只负责**外壳**——标题、提示、两个确认对话框、拉数据——以及把每条记录交给
 * `DraftCard`。卡片长什么样（含折叠/展开）归那个组件，草稿 tab 与这里共用它。
 *
 * 为什么不是 `conversation.composer.dock`：那个槽位在 InputBar 末尾、卡片之后渲染，
 * 但只在 `variant === 'composer' && input !== undefined && sessionId !== undefined`
 * 时才渲染（ui-conversation `skeleton/InputBar.tsx` 尾部）——**hero 态根本不渲染**，
 * 换过去会让列表在新会话页整块消失。hero 态里也没有别的「卡片之后」的槽位
 * （ConversationRoot 的 composerStack 顺序是 HeroShell → input.dock → inputBar），
 * 所以保留这个槽位并用 CSS `order` 排到卡片之后（见 `styles.ts`）。
 *
 * **显示范围：只在新会话（hero）页。** 会话页里草稿的常驻入口是 `conversation.view`
 * 上的「草稿」tab，而**那个 tab 在 hero 态不挂载**（实测 hero 页面 `[role=tab]` 为空）：
 * 两边同时沉默就会出现「添加完草稿却看不到」。所以 hero 需要这个列表兜住，会话页
 * 则交给 tab，既不重复也不留空窗。判定见 `list-scope.ts`。
 *
 * 判定依据是会话快照的 `blank`，**不是 sessionId**：实机 fiber 探针（3088 实例）读数，
 * hero 态 `data-phase="hero"`、`[role=tab]` 为空，而 `props.sessionId` 与
 * `props.session.blank === true` 同时成立；打开侧栏已有会话后 `data-phase="active"`、
 * 三个 tab 齐全、`props.session.blank === false`，**sessionId 同样存在**。也就是说
 * 「有 sessionId 就不显示」会把列表在两种状态下一起隐藏，等于让它永不出现。
 *
 * `blank` 是**一等契约字段**，不是内部细节，所以依赖它是安全的：
 *   · `@deepseek-ai/dsh-api-session-controller` 的会话快照与 ui-conversation 的
 *     `contract/snapshot.ts` 都把它声明为 `readonly blank: boolean`；
 *   · 宿主用例 `tests/session-list-blank.host.spec.ts` 写下语义「summary blank bit
 *     means "conversation not started" (no turn has run)」，并且「the first turn
 *     clears blank」；
 *   · ui-conversation `sessions/session.ts` 里它只降不升（never re-blanks）。
 * 因此「新会话页」这个生命周期用 `blank` 表达比用 sessionId 更贴切。
 *
 * 关于「要不要先确认覆盖」：框架在两种 phase 下都会渲染本槽位
 * （ui-conversation `skeleton/ConversationRoot.tsx`：`{zone !== undefined && renderSlot(...)}`），
 * 是本组件自己按 `blank` 在会话页收起的；而**新会话页的输入框同样可能装着用户正在写的内容**
 * （实测 hero 态 composer 里就有文本）。也就是说：在那里点一下 `setDraft` 会把那些内容
 * **整体替换**掉。所以它与草稿 tab 用同一份 `shouldConfirmOverwrite` 判定、同一句确认文案
 * （`confirm-dialogs.ts`），而不是保留静默覆盖。
 *
 * 另一个与第 5 条相关的坑：`noteComposerChange` **必须留在 hero 提前 return 之前**
 * （见方法处注释）。草稿 tab 的面板并不是常驻的——`ConversationSession.tsx` 在
 * `session.blank && phase === 'blank'` 时直接返回 null，且 `renderSlot('conversation.view', …,
 * { only: active.id })` 只为**当前选中的那个 view** 渲染内容，所以会话页停在「对话」tab 时
 * `DraftView` 根本没挂载。若把通知挪到 `if (!hero) return null` 之后，那种会话里
 * 「输入框被清空」就没有观测者上报，`active-draft` 的复位（清 active 标志与元素激活集）会漏。
 *
 * 组件本身加载不了（仓库只装了 `@types/react`，没有 react 运行时）：hero 判定、
 * 覆盖判定都有纯函数单测；列表渲染、对话框归浏览器验收。
 */

import { React, h } from './react'
import { hostCall, logError } from './host-call.ts'
import { noteComposerChange } from './active-draft.ts'
import { performRestore, restoreNotice, shouldConfirmOverwrite } from './restore-action.ts'
import { isNewSessionHero } from './list-scope.ts'
import { useDraftRevision } from './draft-events.ts'
import { DeleteConfirmDialog, RestoreConfirmDialog } from './confirm-dialogs.ts'
import { DraftCard } from './DraftCard.ts'
import { ToastNotice, nextNotice, type Notice } from './toast-notice.ts'
import type { ClientCtx, DraftStripProps } from './services.ts'
import type { DraftRecord } from '../shared/types.ts'

/** 最多展示几条，避免新会话页被草稿列表淹没。 */
const MAX_ROWS = 5

/**
 * 列表上的反馈：**成功走 toast、失败与警告留在行内**。
 *
 * 两者是同一块状态而不是两份：一次动作要么留痕要么飘走，不该同时出现（见 toast-notice.ts
 * 的分工）。`kind` 决定画在哪也一样由这里定，调用点只需说清是哪种。
 */
type StripNotice = { kind: 'toast'; notice: Notice } | { kind: 'inline'; text: string }

/** 新会话（hero）页的「最近草稿」列表：每条可回弹、可删除，删除前二次确认。 */
export function DraftStrip(props: DraftStripProps): unknown {
  const [records, setRecords] = React.useState<DraftRecord[]>([])
  const [notice, setNotice] = React.useState<StripNotice | null>(null)
  // 忙：回弹/删除进行中，卡片上的两个动作按钮一起置灰，避免重复提交
  const [busy, setBusy] = React.useState(false)
  const [pendingConfirm, setPendingConfirm] = React.useState<DraftRecord | null>(null)
  const [pendingDelete, setPendingDelete] = React.useState<DraftRecord | null>(null)
  // toast 横向居中的参照物（本列表；平台默认按视口居中，锚一下更贴近操作发生的位置）
  const rootRef = React.useRef<HTMLDivElement | null>(null)

  const draft = props.useInput ? props.useInput((s) => s.draft) : ''
  const attachmentIds = props.useInput ? props.useInput((s) => s.attachmentIds) : []

  /** 成功类反馈：飘一条 toast（下一次展示换 key，同一句话也重新计时）。 */
  const showToast = (text: string): void => { setNotice({ kind: 'toast', notice: nextNotice(text) }) }
  /** 失败/警告：留在列表上方，用户能对着它找是哪一条出的问题。 */
  const showInline = (text: string): void => { setNotice({ kind: 'inline', text }) }
  /** toast 淡出结束：卸掉它。已经是行内提示时不动（免得白渲染一帧）。 */
  const dismissToast = (): void => {
    setNotice((current) => (current !== null && current.kind === 'toast' ? null : current))
  }

  // 保存成功后由 SaveDraftButton 自增版本号，这里跟着重拉一次：本列表与草稿 tab 挂在
  // 不同的槽位上，没有共同父组件，这是两者唯一的刷新通道（见 draft-events.ts）。
  // **必须在下面那些提前 return 之前调用**：列表为空时本组件返回 null，但仍然是挂载着的
  // （函数组件 return null 不影响 hooks 与订阅），正是靠这一点才能在「一行都还没有」的
  // 时候收到第一次刷新。
  const revision = useDraftRevision()

  // 只在 hero 态渲染（文件头）：会话页交给草稿 tab
  const hero = isNewSessionHero(props.session)

  // 与草稿 tab 同一次通知：两个观测者谁先渲染都行，协调器的模块级闸门保证只发一次请求。
  // **必须无条件调用**（不能挪到下面 hero 判定之后）：草稿 tab 的面板不是常驻的
  // （`ConversationSession.tsx` 只为当前选中的 view 渲染内容），会话页停在别的 tab 时
  // 本列表是唯一还会通知协调器的观测者——挪到提前 return 之后，那种会话里「输入框被清空」
  // 就没人上报了。这里传 undefined 表示「观测不到」，不是「输入框是空的」——报一个空输入框
  // 会立刻清掉刚回弹成功的元素集。
  noteComposerChange(props.useInput ? { draft, attachmentIds } : undefined)

  const reload = React.useCallback(() => {
    hostCall('draft-list')
      .then((res) => {
        if (res.ok) setRecords(res.records ?? [])
        // 两条失败路径都只留痕、不弹提示：这条列表是锦上添花，读不到就整块不渲染，
        // 不能因为一次列表失败把 composer 拖下水（也不该静默——静默的失败无人能查）
        else logError('读取草稿列表失败（空会话草稿列表不展示）', res.error)
      })
      .catch((err: unknown) => {
        logError('读取草稿列表失败（空会话草稿列表不展示）', err)
      })
  }, [])

  React.useEffect(() => {
    // 会话页整块不渲染，这一次请求也就不必发
    if (!hero) return
    reload()
    // revision 是依赖而不是「额外的一次性重拉」：每次保存成功都会换一个新版本号，
    // 于是 hero 态下的列表跟着重拉一次（挂载时的那一次就是初值这一次）
  }, [hero, reload, revision])

  // 展示最近草稿（最多 MAX_ROWS 条），不按本会话过滤：hero 页面前面那几条同样点得到，
  // 而「本会话」在新会话页本来就没有草稿。
  const others = records.slice(-MAX_ROWS).reverse()
  if (!hero || others.length === 0) return null

  /** 真正执行回弹（二次确认之后，或输入框为空时直接走这里）。 */
  const runRestore = (record: DraftRecord): void => {
    setPendingConfirm(null)
    setBusy(true)
    setNotice(null)
    // performRestore 不 reject（传输层失败也折成 ok:false），所以这里不需要 catch
    void performRestore(props.ctx as ClientCtx, props.sessionId, record, props.inputActions ?? {})
      .then((outcome) => {
        // 成功文案这里刻意可能是空串（回弹成功、附件没缺就不占位）；warning 不能被
        // 这条空串吞掉——restoreNotice 空段自动丢，只剩警告时也照常显示。
        // 失败与带警告走行内：那两种情况要留在原地供人对照，飘走就看不到了；
        // 纯成功飘 toast。**空串什么都不飘**——不然会弹出一条只有图标的空横幅
        //（这句空串是"没话可说"的约定，不是"成功"的信号，见 restoreNotice）
        const successText = outcome.missing > 0 ? '已回弹，' + outcome.missing + ' 个附件未能恢复' : ''
        const text = restoreNotice(outcome, successText)
        if (text !== '') {
          if (outcome.ok && outcome.warning === undefined) showToast(text)
          else showInline(text)
        }
        // 回弹会把这条记为「当前草稿」，卡片上的 `当前` 徽标要跟着出现（tab 那边同理）
        if (outcome.ok) reload()
      })
      .finally(() => { setBusy(false) })
  }

  const onRestore = (record: DraftRecord): void => {
    // 输入框非空时先确认：这里的点击同样是整体替换（见文件头）
    if (shouldConfirmOverwrite(draft, attachmentIds)) setPendingConfirm(record)
    else runRestore(record)
  }

  /**
   * 删除一条草稿（二次确认之后）。
   *
   * **不吞信封**：`ok:false` 是真实业务失败（例如草稿已被别处删掉），必须落在提示上，
   * 不能只刷新列表装作删掉了——这正是 `draft-set-active` 那条教训的同型问题。
   * 传输层抛错（hostCall 在非 2xx 时抛）同样要落提示，否则用户点了删除毫无反馈。
   */
  const runRemove = (record: DraftRecord): void => {
    setPendingDelete(null)
    setBusy(true)
    setNotice(null)
    hostCall('draft-remove', { id: record.id })
      .then((res) => {
        if (!res.ok) {
          logError('删除草稿失败：' + record.id, res.error)
          showInline('删除失败：' + (res.error ?? '未知错误'))
          return
        }
        // 成功走 toast：删除不产生可对照的东西，行内那行字除了占位没有别的用处
        showToast('已删除草稿')
        reload()
      })
      .catch((err: unknown) => {
        logError('删除草稿失败：' + record.id, err)
        showInline('删除失败：' + String((err as Error)?.message || err))
      })
      .finally(() => { setBusy(false) })
  }

  return h(
    'div',
    { className: 'dsh-pi-strip', ref: rootRef },
    h('div', { className: 'dsh-pi-strip-head' }, '最近草稿'),
    // toast 由平台 portal 到 body，画在哪都行；行内提示留在列表上方。
    // **它随本列表一起卸载**是想要的行为：列表都没了，那次动作的反馈也不该继续飘着
    h(ToastNotice, {
      notice: notice?.kind === 'toast' ? notice.notice : null,
      anchor: rootRef.current,
      onDone: dismissToast,
    }),
    notice?.kind === 'inline' ? h('div', { className: 'dsh-pi-notice' }, notice.text) : null,
    // 两个确认对话框都挂在平台 Modal 上（createPortal 到 body），因此不受本列表的
    // flex/order 布局影响；cancel 只关框，什么都不写
    h(RestoreConfirmDialog, {
      open: pendingConfirm !== null,
      disabled: busy,
      onCancel: () => { setPendingConfirm(null) },
      onConfirm: () => { if (pendingConfirm !== null) runRestore(pendingConfirm) },
    }),
    h(DeleteConfirmDialog, {
      open: pendingDelete !== null,
      disabled: busy,
      onCancel: () => { setPendingDelete(null) },
      onConfirm: () => { if (pendingDelete !== null) runRemove(pendingDelete) },
    }),
    others.map((record) => h(DraftCard, {
      key: record.id,
      record,
      currentSessionId: props.sessionId,
      busy,
      restoreDisabled: props.inputActions === undefined,
      onRestore: () => { onRestore(record) },
      onDelete: () => { setPendingDelete(record) },
      collapsible: true,
    })),
  )
}
