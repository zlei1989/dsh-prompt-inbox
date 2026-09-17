/**
 * React 单点引入。
 *
 * 浏览器模块表通过闭包注入的 `require` 提供 react——只在这里 require 一次，
 * 其余模块从这里导入，避免重复请求同一个平台模块。类型来自
 * `@types/react`（仅类型，不产生运行时依赖）。
 */

import type * as ReactNS from 'react'

export const React = require('react') as typeof ReactNS
export const h = React.createElement
