/**
 * `list-scope.ts` 的单测：「最近草稿」列表的显示范围判定。
 *
 * 只测纯函数，不断言组件行为——`DraftStrip` 模块 import react，而仓库只装了
 * `@types/react`，Node 里加载不了组件。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { isNewSessionHero } from '../../src/client/list-scope.ts'

test('isNewSessionHero：只有会话快照 blank=true（新会话/hero）才显示最近草稿列表', () => {
  // hero：会话视图还没有任何历史
  assert.equal(isNewSessionHero({ blank: true }), true)
  // 会话页：已有历史，草稿的入口是「草稿」tab，列表整块不渲染
  assert.equal(isNewSessionHero({ blank: false }), false)
  // 拿不到会话快照：不算 hero（宁可少显，也不在会话页多显一份）
  assert.equal(isNewSessionHero(undefined), false)
})

test('isNewSessionHero：blank 缺失当作「不是新会话」，字段改名时宁可不显示', () => {
  assert.equal(isNewSessionHero({}), false)
})
