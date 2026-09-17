/**
 * `DraftCard` 的接线契约：两个界面共用同一张卡片，且折叠/展开各自只画该画的部分。
 *
 * **为什么读源码文本而不是渲染它**：仓库只装了 `@types/react`，没有 react 运行时
 * （见 `AGENT.md`），组件在 Node 里 import 不进来——`DraftCard` 依赖的
 * `draft-record` / `shared/types` 都能加载，但顶层 `require('react')` 不行。
 * 所以这里断言的是**接线事实**（谁渲染它、哪些节点挂在哪个分支下），渲染结果本身
 * 归浏览器验收。这类断言的价值在于挡住"两处各画一套"的回潮：那正是本次重构要消除的
 * 东西，而它在类型检查、样式测试与功能测试里都看不见。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { source } from './source-text.ts'

/**
 * 取 `h(selector, …)` 调用中**对象参数**之后的那段实参文本（一直到调用闭合）。
 *
 * 用括号配平扫描而不是正则：那段实参里嵌着更多 `h(...)`，正则数不清层级。
 */
function argumentAfterOptions(src: string, selector: string): string {
  const at = src.indexOf("h('" + selector + "'")
  assert.ok(at >= 0, '源码里找不到 h(' + selector + ') 调用')
  // 先跳过选择器字符串与它的逗号，再从 `{` 开始配平对象参数
  const optsAt = src.indexOf('{', at)
  assert.ok(optsAt > at, 'h(' + selector + ') 后面没有对象参数')
  let depth = 0
  let optsEnd = -1
  for (let i = optsAt; i < src.length; i++) {
    const ch = src[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) { optsEnd = i; break }
    }
  }
  assert.ok(optsEnd > 0, 'h(' + selector + ') 的对象参数没有闭合')
  // 从对象参数末尾往后扫到本次调用闭合，途中遇到嵌套 h( 就多压一层
  let callDepth = 0
  for (let i = optsEnd + 1; i < src.length; i++) {
    if (src.startsWith('h(', i)) { callDepth++; i++ }
    else if (src[i] === ')') {
      if (callDepth === 0) return src.slice(optsEnd, i)
      callDepth--
    }
  }
  assert.fail('h(' + selector + ') 调用没有闭合')
}

const card = source('src/client/DraftCard.ts')
const strip = source('src/client/DraftStrip.ts')
const view = source('src/client/DraftView.ts')

test('两个界面都渲染共用卡片，都不再自绘卡片 DOM', () => {
  for (const [name, src] of [['DraftStrip', strip], ['DraftView', view]] as const) {
    assert.match(src, /import \{ DraftCard \} from '\.\/DraftCard\.ts'/, name + ' 没有引入共用卡片')
    assert.match(src, /h\(DraftCard, \{/, name + ' 没有渲染共用卡片')
    // 自绘的痕迹：卡片类名只该出现在 DraftCard 里
    assert.equal(src.includes('dsh-pi-item-head'), false, name + ' 仍在自绘卡片头部')
    assert.equal(src.includes('dsh-pi-actions'), false, name + ' 仍在自绘动作行')
  }
})

test('两个界面各自声明形态：列表折叠、tab 恒定展开', () => {
  assert.match(strip, /collapsible:\s*true/)
  assert.match(view, /collapsible:\s*false/)
})

test('列表里旧的行内按钮不得回潮', () => {
  // 这些类名连同样式规则一起被复用掉了（见 styles.test.ts 的同名断言）；它们一旦
  // 回到 DraftStrip，就说明列表又在自己画行，而不是把记录交给共用卡片。
  for (const dead of ['.dsh-pi-strip-row', '.dsh-pi-strip-main', '.dsh-pi-strip-text']) {
    assert.equal(strip.includes(dead), false, 'DraftStrip 里不该再有：' + dead)
  }
})

test('折叠态只有第一行正文，且没有可点的破坏性动作', () => {
  // 头部只画正文节点与徽标，不直接画任何动作
  assert.match(argumentAfterOptions(card, 'div'), /\bbody,/)
  // 折叠时正文是 `<button>`，带 aria-expanded 与 onClick——而不是回弹按钮：
  // 在列表里点一下不该发生"覆盖输入框"这种事
  const bodyAt = card.indexOf('const body = expanded')
  assert.ok(bodyAt > 0, '找不到正文节点的分支')
  const expandedBranch = card.indexOf("h('span'", bodyAt)
  const collapsedBranch = card.indexOf("h(\n        'button'", bodyAt)
  assert.ok(expandedBranch > bodyAt, '展开态正文应当是 span')
  assert.ok(collapsedBranch > expandedBranch, '折叠态正文应当是 button')
  const collapsed = card.slice(collapsedBranch)
  assert.match(collapsed, /aria-expanded/)
  assert.match(collapsed, /onClick/)
  // 摘要/时间与动作行两处的条件都必须含 `expanded`——漏掉一处，折叠态就会露出
  // 删除按钮或元信息行。
  const meta = card.indexOf("'dsh-pi-item-meta'")
  const actions = card.indexOf("'dsh-pi-actions'")
  assert.ok(meta > 0 && actions > meta, '找不到元信息/动作行节点')
  const metaGuard = card.slice(card.lastIndexOf('expanded', meta), meta)
  const actionsGuard = card.slice(card.lastIndexOf('expanded', actions), actions)
  assert.match(metaGuard, /^expanded\s*\?/, '元信息行没有挂在 expanded 之下')
  assert.match(actionsGuard, /^expanded\s*\?/, '动作行没有挂在 expanded 之下')
})

test('卡片正文不按字符数截断，省略号留给 CSS 按宽度裁决', () => {
  // 正文必须走 `flattenLine`（只折叠空白）；用回 `previewLine` 就会在远未溢出的位置
  // 先砍一刀，"超出范围才省略号"永远看不到，展开后也补不回被砍掉的字。
  assert.match(card, /const text = flattenLine\(/)
  assert.equal(/const text = previewLine\(/.test(card), false, '正文不该再走 previewLine')
  // 收短后的 previewLine 只能进属性（可访问名 / title），不能当正文用
  assert.match(card, /const hint = previewLine\(/)
})

test('展开态与草稿 tab 一致：文字按钮 回弹 / 删除 各一个，不嵌套按钮', () => {
  for (const label of ["'回弹'", "'删除'"]) {
    assert.equal(card.split(label).length - 1, 1, 'DraftCard 里 ' + label + ' 按钮应当恰好一个')
  }
  // 折叠态的正文按钮在展开后必须变成 `span`：否则卡片里会出现第二个按钮，
  // 且它的可访问名与"回弹"按钮重名。
  assert.match(card, /const body = expanded\s*\n\s*\? h\('span'/)
})
