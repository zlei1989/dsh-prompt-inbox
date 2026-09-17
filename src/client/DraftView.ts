/**
 * 草稿 tab：`conversation.view` 上的一个视图（`label: () => '草稿'`）。
 *
 * 数据全部来自 host（单一事实源），本组件只在挂载/操作后重新拉取，
 * 不缓存副本——列表因此永远和 jsonl 一致。**保存成功**那一次重拉不来自本组件内部：
 * 保存按钮挂在另一个槽位上，只能经 `draft-events.ts` 的模块级版本号通知（见下）。
 *
 * 卡片本身归 `DraftCard`（与最近草稿列表共用），本文件只负责 tab 的外壳：计数标题、
 * 「全部会话」开关、提示、确认对话框，以及按会话过滤。因此这里的卡片**恒定展开**，
 * 与折叠形态无关。
 *
 * 「回弹前要不要先确认覆盖」不问在这个文件里：判定是 `restore-action.ts` 的
 * `shouldConfirmOverwrite`（纯函数、Node 里可测），本文件只负责据此打开确认对话框。
 * 回弹覆盖与删除两处确认都用平台 Modal（`confirm-dialogs.ts`），不再自绘面板。
 * 组件本身加载不了（仓库只装了 `@types/react`，没有 react 运行时），所以对话框、
 * 按钮与可见性都归浏览器验收。
 */

import { React, h } from './react'
import { hostCall } from './host-call.ts'
import { noteComposerChange } from './active-draft.ts'
import { performRestore, restoreNotice, shouldConfirmOverwrite } from './restore-action.ts'
import { useDraftRevision } from './draft-events.ts'
import { DeleteConfirmDialog, RestoreConfirmDialog } from './confirm-dialogs.ts'
import { DraftCard } from './DraftCard.ts'
import { ToastNotice, nextNotice, type Notice } from './toast-notice.ts'
import type { ClientCtx, DraftViewProps } from './services.ts'
import type { DraftRecord } from '../shared/types.ts'

/**
 * 面板上的反馈：**成功走 toast、失败与警告留在顶部**（与 `DraftStrip` 同一套判定，
 * 分工见 `toast-notice.ts`）。同一块状态而不是两份：一次动作要么留痕要么飘走。
 */
type ViewNotice = { kind: 'toast'; notice: Notice } | { kind: 'inline'; text: string }

/** 草稿 tab 组件。 */
export function DraftView(props: DraftViewProps): unknown {
  const [records, setRecords] = React.useState<DraftRecord[]>([])
  const [showAll, setShowAll] = React.useState(false)
  const [notice, setNotice] = React.useState<ViewNotice | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [pendingConfirm, setPendingConfirm] = React.useState<DraftRecord | null>(null)
  const [pendingDelete, setPendingDelete] = React.useState<DraftRecord | null>(null)
  // toast 横向居中的参照物（本面板；不传则平台按视口居中）
  const rootRef = React.useRef<HTMLDivElement | null>(null)

  const draft = props.useInput ? props.useInput((s) => s.draft) : ''
  const attachmentIds = props.useInput ? props.useInput((s) => s.attachmentIds) : []

  /** 成功类反馈：飘一条 toast。 */
  const showToast = (text: string): void => { setNotice({ kind: 'toast', notice: nextNotice(text) }) }
  /** 失败/警告：留在面板顶部，供人对究竟是哪一条出的问题。 */
  const showInline = (text: string): void => { setNotice({ kind: 'inline', text }) }
  /** toast 淡出结束：卸掉它（已是行内提示时不动，免得白渲染一帧）。 */
  const dismissToast = (): void => {
    setNotice((current) => (current !== null && current.kind === 'toast' ? null : current))
  }

  // 输入框现状每变一次就通知协调器：回弹成功后输入框被清空（发送或手动清空）时，由它
  // 发出那一次「复位当前草稿 + 清空元素激活集」的请求。幂等且非空输入框是空操作，
  // 所以放在渲染路径上安全（判定与边界见 active-draft.ts）。
  // 槽位没给 `useInput` 时传 undefined 而不是上面那两个兜底值：**观测不到不等于空**——
  // 报一个空输入框会让刚回弹成功的元素集在下一次渲染就被清掉。
  noteComposerChange(props.useInput ? { draft, attachmentIds } : undefined)

  // 保存成功后由 SaveDraftButton 自增版本号，这里跟着重拉一次：草稿 tab 与 hero 态的
  // 「最近草稿」列表挂在不同的槽位上，没有共同父组件，这是两者唯一的刷新通道
  // （见 draft-events.ts）。本面板只在被选中时挂载，因此这条通知只在它确实开着时生效。
  const revision = useDraftRevision()

  const reload = React.useCallback(() => {
    hostCall('draft-list').then((res) => {
      if (res.ok) setRecords(res.records ?? [])
      else showInline('读取草稿列表失败：' + (res.error ?? '未知错误'))
    }).catch((err: unknown) => {
      showInline('读取草稿列表失败：' + String((err as Error)?.message || err))
    })
  }, [])

  // 挂载时拉一次；此后每次保存成功（版本号变化）再拉一次
  React.useEffect(() => { reload() }, [reload, revision])

  const visible = showAll
    ? records
    : records.filter((r) => r.originSessionId === props.sessionId)

  /** 真正执行回弹（二次确认之后，或输入框为空时直接走这里）。 */
  const runRestore = (record: DraftRecord): void => {
    setPendingConfirm(null)
    setBusy(true)
    setNotice(null)
    performRestore(props.ctx as ClientCtx, props.sessionId, record, props.inputActions ?? {})
      .then((outcome) => {
        // 成功文案与 warning 由 restoreNotice 拼在一起（如「已回弹草稿；草稿已回弹，
        // 但未能标记为当前草稿」）——置 active 失败不能被成功文案盖掉
        const successText = outcome.missing > 0
          ? '已回弹草稿，但有 ' + outcome.missing + ' 个附件未能恢复'
          : '已回弹草稿'
        const text = restoreNotice(outcome, successText)
        // 纯成功飘 toast；失败与警告留行内（要留在原地供人对照）。
        // 空串什么都不飘——那是"没有要报的"的约定（见 restoreNotice），不是成功信号
        if (text !== '') {
          if (outcome.ok && outcome.warning === undefined) showToast(text)
          else showInline(text)
        }
        // 失败时列表没变，不必重拉（回弹只改输入框与 active 标记）
        if (outcome.ok) reload()
      })
      .finally(() => { setBusy(false) })
  }

  const onRestore = (record: DraftRecord): void => {
    // 输入框非空时先确认——setDraft 是整体替换语义，覆盖掉的内容找不回来
    if (shouldConfirmOverwrite(draft, attachmentIds)) setPendingConfirm(record)
    else runRestore(record)
  }

  /**
   * 删除一条草稿（确认对话框点「删除」之后才走到这里）。
   *
   * 信封不吞：`draft-remove` 返回 `ok:false`（例如草稿已被别处删掉）时把 `error`
   * 原样落到提示上，**不报成功**；只有真的删掉才 reload 列表并报「已删除草稿」。
   * 失败时不 reload 是有意的：这一行还在列表里，而失败原因已经写在提示上了，
   * 贸然重拉会让「删不掉的那条」无声消失，看起来反而像删成功了。
   */
  const onRemove = (record: DraftRecord): void => {
    setPendingDelete(null)
    setBusy(true)
    hostCall('draft-remove', { id: record.id })
      .then((res) => {
        if (!res.ok) showInline('删除失败：' + (res.error ?? '未知错误'))
        else { showToast('已删除草稿'); reload() }
      })
      .catch((err: unknown) => { showInline('删除失败：' + String((err as Error)?.message || err)) })
      .finally(() => { setBusy(false) })
  }

  return h(
    'div',
    { className: 'dsh-pi-view', ref: rootRef },
    h('div', { className: 'dsh-pi-view-head' },
      h('span', { className: 'dsh-pi-title' }, '草稿（' + visible.length + '）'),
      h('label', { className: 'dsh-pi-toggle' },
        h('input', { type: 'checkbox', checked: showAll, onChange: () => { setShowAll(!showAll) } }),
        '全部会话',
      ),
    ),
    // toast 由平台 portal 到 body；行内提示留在面板顶部。
    // **它随本面板一起卸载**是想要的行为：面板切走/收起后，那次动作的反馈也不该继续飘着
    h(ToastNotice, {
      notice: notice?.kind === 'toast' ? notice.notice : null,
      anchor: rootRef.current,
      onDone: dismissToast,
    }),
    notice?.kind === 'inline' ? h('div', { className: 'dsh-pi-notice' }, notice.text) : null,
    // 两个确认对话框都走平台 Modal（portal 到 body）：回弹覆盖与删除各自一个，
    // 取消只关框——回弹与删除都是「确认才发生」的动作
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
      onConfirm: () => { if (pendingDelete !== null) onRemove(pendingDelete) },
    }),
    visible.length > 0
      ? visible.map((record) => h(DraftCard, {
          key: record.id,
          record,
          currentSessionId: props.sessionId,
          busy,
          restoreDisabled: props.inputActions === undefined,
          onRestore: () => { onRestore(record) },
          onDelete: () => { setPendingDelete(record) },
          collapsible: false,
        }))
      : h('div', { className: 'dsh-pi-empty' }, showAll ? '还没有任何草稿' : '本会话还没有草稿'),
  )
}
