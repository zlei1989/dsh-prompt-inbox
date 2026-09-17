/**
 * 草稿列表刷新通道（`draft-events.ts` 的模块级版本号）的用例。
 *
 * 这里只测**计数器**：订阅/退订、一次 bump 通知每个订阅者一次、以及「订阅 + 读快照」
 * 这个组件式消费者能看到新值。`useDraftRevision` 这个 hook 本身在 Node 里跑不了
 * （仓库只装了 `@types/react`，没有 react 运行时），所以本文件**不声称任何 hook 行为**，
 * 用例名也只说计数器——hook 是否真的把组件接上去由浏览器验收（Task 10 同款）。
 *
 * 模块级状态跨用例残留，因此每条用例都自己退订、并只用**相对**读数（先取 before 再比），
 * 不假设版本号从 0 开始（见 `active-draft.test.ts` 的 `resetActiveDraftForTest` 同类问题）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bumpDraftRevision, getDraftRevision, subscribe } from '../../src/client/draft-events.ts'

test('subscribe：订阅后收到通知，退订后不再收到（重复退订无副作用）', () => {
  let calls = 0
  const off = subscribe(() => { calls += 1 })

  bumpDraftRevision()
  assert.equal(calls, 1)

  off()
  // 退订幂等：Set.delete 对不存在的项是空操作，重复调用不该抛、也不该影响别人
  off()
  bumpDraftRevision()
  assert.equal(calls, 1)
})

test('bumpDraftRevision：一次 bump 通知每个订阅者一次，且回调里读到的快照已是新值', () => {
  const before = getDraftRevision()
  const seen: number[] = []
  const offA = subscribe(() => { seen.push(getDraftRevision()) })
  const offB = subscribe(() => { seen.push(getDraftRevision()) })
  try {
    bumpDraftRevision()
    // 两个订阅者各一次；先自增再通知，所以回调里读到的不是旧值
    assert.deepEqual(seen, [before + 1, before + 1])
    assert.equal(getDraftRevision(), before + 1)

    // 连续两次 bump 是两个不同的版本号：useSyncExternalStore 按值比较，同值不会重渲染
    bumpDraftRevision()
    assert.equal(getDraftRevision(), before + 2)
    assert.deepEqual(seen, [before + 1, before + 1, before + 2, before + 2])
  } finally {
    offA()
    offB()
  }
})

test('subscribe：组件式消费者（订阅 + 每次回调重读快照）能看到新值', () => {
  // 模拟 useSyncExternalStore 的两半：初始渲染读一次快照，之后每次通知重读一次。
  // 这条钉的是「通知到达时快照已经变新」——若 bump 先通知再自增，消费者会永远读到旧值。
  let rendered = getDraftRevision()
  const off = subscribe(() => { rendered = getDraftRevision() })
  try {
    const before = getDraftRevision()
    bumpDraftRevision()
    assert.equal(rendered, before + 1)

    bumpDraftRevision()
    assert.equal(rendered, before + 2)
  } finally {
    off()
  }
})

test('subscribe：退订只影响自己，其他订阅者照常收到通知', () => {
  // 两个列表（hero 列表与草稿 tab）同时订阅是常态：一个卸载不能把另一个的刷新掐掉
  let kept = 0
  let dropped = 0
  const offKept = subscribe(() => { kept += 1 })
  const offDropped = subscribe(() => { dropped += 1 })
  try {
    offDropped()
    bumpDraftRevision()
    assert.equal(kept, 1)
    assert.equal(dropped, 0)
  } finally {
    offKept()
    offDropped()
  }
})
