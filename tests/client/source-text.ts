/**
 * 读源码文本的小工具：给"只能在 Node 里读文本、不能在 Node 里渲染"的组件做接线断言。
 *
 * 为什么需要它：仓库只装了 `@types/react`，没有 react 运行时（见 `AGENT.md`），凡是
 * import 了 `./react` 的组件模块在 `node --test` 里都加载不进来。所以这类文件断言的是
 * **接线事实**（谁渲染谁、哪段节点挂在哪个分支下、死选择器有没有回潮）——它们在类型检查、
 * 样式测试与功能测试里都看不见，而渲染结果本身归浏览器验收。
 *
 * 各测试文件原先各写一份 readFileSync，抽到这里只有一份路径规则。
 */

import { readFileSync } from 'node:fs'

/** 读仓库内某个文件的源码文本（相对仓库根；`pnpm test` 的工作目录就是根）。 */
export function source(relPath: string): string {
  return readFileSync(new URL('../../' + relPath, import.meta.url), 'utf8')
}
