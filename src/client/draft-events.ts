/**
 * 草稿列表的刷新通道：一个模块级版本号（计数器）+ 订阅。
 *
 * 为什么需要它：保存成功后有两个列表要重拉—— `conversation.input.dock` 上的
 * 「最近草稿」列表与 `conversation.view` 上的草稿 tab。两者由框架挂在**不同的槽位**里，
 * 面板挂载时机也各不相同（草稿 tab 只在被选中时渲染），**没有共同父组件**，回调传不过去；
 * 模块级通道是两者唯一能共用的东西。`active-draft.ts` 是同一套路的先例（模块级状态 +
 * 订阅者各自上报）。
 *
 * 刷新是**拉**不是推：版本号只负责说「草稿集变了」，具体内容仍由两个列表自己重新
 * `draft-list`（host 是唯一事实源，这里不缓存任何记录）。
 *
 * 除 hook 外不认识 React：计数器因此能在 Node 单测里跑真身（仓库只装了 `@types/react`，
 * 没有 react 运行时）。hook 里的 `require('react')` **刻意写在函数体内**——挪到模块顶层
 * （或改从 `react.ts` 静态引入）会让整个模块在 Node 里加载失败，计数器就再也测不了了；
 * 组件侧的单点引入仍是 `react.ts`，这里只是把引入推迟到 hook 真正被调用的时刻。
 */

/** 订阅者集合：Set 的 delete 幂等，退订重复调用无副作用。 */
const listeners = new Set<() => void>()

/**
 * 当前版本号。
 *
 * 用自增的原始值（不是对象）：`useSyncExternalStore` 按 `Object.is` 比较快照，
 * 每变一次必须是一个**新值**，否则 React 判定「没变」而不重渲染。
 */
let revision = 0

/**
 * 订阅版本号变化。
 *
 * @param listener - 版本号变化时被调用（不带参数，调用方自己读快照）。
 * @returns 退订函数。
 */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * 读当前版本号。
 *
 * 同时是 `useSyncExternalStore` 的 `getSnapshot`：必须是稳定引用（每次渲染都给同一个
 * 函数，否则 React 会反复重订阅）且返回原始值。
 */
export function getDraftRevision(): number {
  return revision
}

/**
 * 通知所有订阅者「草稿集变了」：版本号自增 + 逐个回调。
 *
 * **只在保存成功后调用**（`SaveDraftButton` 的成功路径）：失败时 host 上什么都没多出来，
 * 重拉只会白跑一趟，还会把「保存失败」的提示和一次列表刷新混在一起。
 * 清空输入框失败**不影响**它——那次保存确实成功，新草稿必须出现在列表里。
 *
 * 先自增再通知：监听器在回调里读快照时看到的必须是新值。
 * 遍历副本：回调中途退订/新订阅不会打乱本次遍历。
 */
export function bumpDraftRevision(): void {
  revision += 1
  for (const listener of [...listeners]) listener()
}

/**
 * 订阅草稿列表版本号的 hook：版本号变化时组件重渲染，调用方据此重拉列表。
 *
 * `useSyncExternalStore`（React 18）而不是 `useState` + `useEffect`：后者在两次渲染之间
 * 订阅，恰好错过一次通知就会永久停在旧列表上；前者由 React 保证「订阅后立刻重读快照」。
 *
 * @returns 当前版本号；把它放进 `useEffect` 的依赖即可（见 `DraftStrip` / `DraftView`）。
 */
export function useDraftRevision(): number {
  const React = require('react') as typeof import('react')
  return React.useSyncExternalStore(subscribe, getDraftRevision)
}
