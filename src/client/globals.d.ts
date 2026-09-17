/**
 * 浏览器 bundle 的运行时全局变量声明。
 *
 * Client 半以 CJS 闭包形式发布，外层由 web boot 握手包裹
 * （`window.__ModuleLoader__.load({ id, factory })`）：React 通过握手注入的
 * `require` 到达，闭包里的 `module.exports` 是 loader 读取的插件表面。
 * 在此声明，好让 strict 类型检查认识它们。
 */

declare function require(id: string): unknown
declare var module: { exports: Record<string, unknown> }
declare var exports: Record<string, unknown>
