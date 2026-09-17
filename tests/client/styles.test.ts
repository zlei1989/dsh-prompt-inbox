/**
 * `styles.ts` 的单测：几条**只能靠肉眼发现、回归了也照样"能跑"**的版面契约。
 *
 * 这里断言的是样式字符串的接线，不是布局结果——真实几何（卡片与对话消息是否真的
 * 逐像素对齐、折叠态是否真的出一行省略号）只能在浏览器里量，本文档头那条实测记录
 * 就是代替自动化的证据。但「是否还挂在宿主那条宽度轴上」「折叠态是否还把内边距归零」
 * 是字符串层面的事实，可以在 Node 里钉住：一旦有人把 `width: 100%` 加回来、把
 * `max-width` 的变量名写错、或删掉折叠态的内边距归零，切 tab 时内容会整块横跳、
 * 列表行会胖一圈，而这些在类型检查与功能测试里都看不见。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { STYLE_CSS } from '../../src/client/styles.ts'

/** 取一条规则声明块（`选择器 { ... }`）的正文，找不到就断言失败。 */
function ruleBody(selector: string): string {
  const open = STYLE_CSS.indexOf(selector + ' {')
  assert.ok(open >= 0, '样式表里找不到规则：' + selector)
  const from = open + selector.length + 2
  const end = STYLE_CSS.indexOf('}', from)
  assert.ok(end > from, '规则没有闭合：' + selector)
  return STYLE_CSS.slice(from, end)
}

test('草稿 tab 面板走对话列的宽度轴，而不是铺满视图区', () => {
  const body = ruleBody('.dsh-pi-view')
  // 宽度上界必须是宿主发布的内容宽度变量：写死数值会在宿主改宽度轴时脱钩，
  // `width: 100%` 单独出现（没有 max-width）就是原先那个"铺满 1238px"的缺陷本身。
  assert.match(body, /max-width:\s*var\(--dsh-chat-content-width/)
  assert.match(body, /width:\s*100%/)
  assert.match(body, /margin:\s*0 auto/)
})

test('草稿 tab 面板是 border-box：内边距不得撑破宽度上界', () => {
  // 全站没有 `* { box-sizing }` 重置，漏掉这一条会让卡片比对话消息宽出左右内边距之和。
  assert.match(ruleBody('.dsh-pi-view'), /box-sizing:\s*border-box/)
})

test('草稿 tab 面板自带 16px 上下内边距，与消息列离视图区顶部同高', () => {
  // `.viewArea` 自己没有内边距，聊天那 16px 长在滚动容器上；不补这一条面板会顶格。
  assert.match(ruleBody('.dsh-pi-view'), /padding:\s*16px 0/)
})

test('最近草稿列表照抄同栈 TodoPanel 的宽度契约（不与草稿 tab 共用一套）', () => {
  // 两条界面挂在不同的槽位、宽度轴不同：hero 栈里是"输入卡宽减四个 inset"，
  // 误把 `.dsh-pi-view` 那套 max-width 挪过来会让列表比输入卡窄一截。
  const body = ruleBody('.dsh-pi-strip')
  assert.match(body, /var\(--dsh-composer-card-max-width, 100%\)/)
  assert.match(body, /var\(--dsh-composer-dock-inset, 8px\)/)
})

test('卡片字号写死在卡片上（两个槽位的环境字号不同）', () => {
  // 列表挂在 hero 输入卡下面（环境 16px），草稿 tab 挂在 `.dsh-pi-view` 里（12px）。
  // 靠继承就意味着同一张卡片在两处不一样大——这条只能靠字符串钉住。
  assert.match(ruleBody('.dsh-pi-item'), /font-size:\s*12px/)
})

test('折叠卡片保留内边距，只把底距归零（垂直节奏归列表的 gap）', () => {
  // `.dsh-pi-item` 自带 8px 内边距 / 8px 底距：折叠态**留内边距**（去掉的话正文会贴着
  // 卡片边框，与展开态不像同一个东西），但底距必须归零，否则与 `.dsh-pi-strip` 的 gap
  // 叠成双层行距、比展开态卡片之间还松。
  const body = ruleBody('.dsh-pi-item-flat')
  assert.match(body, /padding:\s*[1-9]\d*px/)
  assert.match(body, /margin-bottom:\s*0/)
  // 折叠态正文节点是 `<button>`：content-box 会让内边距与边框长在宽度之外，
  // 整行比条目容器宽（全站没有 `* { box-sizing }` 重置）。
  assert.match(body, /box-sizing:\s*border-box/)
})

test('折叠卡片的正文保留单行省略号，展开后不截断', () => {
  // "超出范围用省略号"这条要求落在 `.dsh-pi-item-text` 上；折叠态那个 `<button>`
  // 必须把浏览器默认外观整体抹掉，否则底色/边框/字体不是卡片那一套。
  assert.match(ruleBody('.dsh-pi-item-text'), /text-overflow:\s*ellipsis/)
  const flat = ruleBody('.dsh-pi-item-flat .dsh-pi-item-text')
  assert.match(flat, /background:\s*transparent/)
  assert.match(flat, /border:\s*0/)
  assert.match(flat, /font:\s*inherit/)
})

test('正文行允许收缩，长正文才会截断而不是顶破卡片', () => {
  // 漏掉 `min-width: 0` 时这一行按 max-content 撑开：卡片比列表宽、被 `overflow: hidden`
  // 切掉，而 `text-overflow: ellipsis` 因为永远不溢出自己的盒子而一次都不生效——
  // 实测正是这么坏的（正文 110 字时按钮宽 1255px、卡片只有 680px）。
  assert.match(ruleBody('.dsh-pi-item-head'), /min-width:\s*0/)
})

test('旧的行内样式不得回潮（卡片只留一套样式源）', () => {
  // 复用之后列表的行内样式整套删掉了；它们一旦回来就说明又出现了"两个事实源"，
  // 而这类回归在类型检查与功能测试里都看不见。
  for (const dead of ['.dsh-pi-strip-row', '.dsh-pi-strip-main', '.dsh-pi-strip-text', '.dsh-pi-strip-del']) {
    assert.equal(STYLE_CSS.includes(dead), false, '样式表里不该再有：' + dead)
  }
})
