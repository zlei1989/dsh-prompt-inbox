/**
 * 反馈通道的分工契约：**成功走 toast、失败与警告留在行内**，两个界面同一套。
 *
 * 这是"删除成功不要占着列表上方那行字"这条要求的落点。之所以用读源码的方式钉住
 * （而不是渲染断言）：组件 import `./react`，而仓库只有 `@types/react`，Node 里加载不了；
 * 真正弹出来的横幅长什么样归浏览器验收，这里只保证**调用点没有走错通道**——
 * 走错了界面照样能用，只是反馈会重新变回那行常驻文字，肉眼不盯就发现不了。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { source } from './source-text.ts'

/** 取某个函数体的文本（从 `const <name> = ` 到声明收尾的分号）。 */
function functionBody(src: string, name: string): string {
  const marker = 'const ' + name + ' = '
  const from = src.indexOf(marker)
  assert.ok(from >= 0, '源码里找不到：' + name)
  // 弹窗与回调里也有分号，所以从函数起点往后找**第一个换行后回到两空格缩进**的 ';'
  const end = src.indexOf('\n  }', from)
  assert.ok(end > from, name + ' 的函数体没有闭合')
  return src.slice(from, end)
}

const strip = source('src/client/DraftStrip.ts')
const view = source('src/client/DraftView.ts')
const toastModule = source('src/client/toast-notice.ts')

for (const [name, src] of [['DraftStrip', strip], ['DraftView', view]] as const) {
  test(name + ' 走平台 Toast，而不是自绘浮层或常驻行', () => {
    assert.match(src, /import \{ ToastNotice, nextNotice, type Notice \} from '\.\/toast-notice\.ts'/)
    assert.match(src, /h\(ToastNotice, \{/)
    // 行内提示只在 kind === 'inline' 时渲染：成功那条不该再出现在这里
    assert.match(src, /notice\?\.kind === 'inline' \? h\('div', \{ className: 'dsh-pi-notice' \}, notice\.text\) : null/)
    // 一次动作只有一块状态，成功与失败互斥，不该两个通道同时亮
    assert.match(src, /type \w+Notice = \{ kind: 'toast'; notice: Notice \} \| \{ kind: 'inline'; text: string \}/)
  })

  test(name + ' 的删除：成功飘 toast、失败留行内', () => {
    const body = functionBody(src, name === 'DraftStrip' ? 'runRemove' : 'onRemove')
    const okAt = body.indexOf("showToast('已删除草稿')")
    const failAt = body.indexOf("showInline('删除失败：'")
    assert.ok(okAt > 0, name + ' 的删除成功没有走 toast')
    assert.ok(failAt > 0, name + ' 的删除失败没有留在行内')
    // 失败必须报，不能被成功那条盖掉
    assert.ok(body.indexOf('if (!res.ok)') < failAt, name + ' 的失败分支顺序不对')
  })

  test(name + ' 的回弹：纯成功飘 toast，带警告或失败留行内', () => {
    const body = functionBody(src, 'runRestore')
    assert.match(body, /text !== ''/)
    assert.match(body, /if \(outcome\.ok && outcome\.warning === undefined\) showToast\(text\)/)
    assert.match(body, /else showInline\(text\)/)
  })
}

test('toast 的 key 来自自增 seq（同一句话连着弹两次也要重新计时）', () => {
  // Toast 的计时挂在 effect 上，React 复用同一实例就不会重新计时——平台自己
  // （InputBar / FeedbackDialog）也用 seq 解决，这里必须跟着做
  assert.match(toastModule, /noticeSeq \+= 1/)
  assert.match(toastModule, /return \{ seq: noticeSeq, text \}/)
  assert.match(toastModule, /key: props\.notice\.seq/)
})

test('toast 的关闭由 onDone 驱动，不是一个自己写的定时器', () => {
  // 停留 + 淡出的时长归平台（holdMs / FADE_MS），本插件不该再抄一份数字
  assert.match(toastModule, /onDone: props\.onDone/)
  assert.equal(/setTimeout/.test(toastModule), false, '不该自己排定时器')
})
