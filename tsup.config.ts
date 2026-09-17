import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig } from 'tsup'

// 从 cwd 读取 manifest，而不是 import.meta.url：tsup 会把这份配置重新打包进一个
// 临时 .mjs 文件再执行，import.meta.url 指向的是那个临时文件而非本文件。
// `pnpm build` 下 process.cwd() 就是包根目录。
const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { name: string }

// Client bundle 的包裹格式：每个声明了 `dsh.client` 的包，其 `./client` 导出都必须是
// 一个闭包工厂。浏览器 loader 从自己的模块表回答平台模块（react）的 `require`，
// 并读取闭包里的 `module.exports` 作为插件表面。
const CLIENT_BANNER = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(pkg.name)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
`
const CLIENT_FOOTER = `
    return module.exports;
  },
});
`

export default defineConfig([
  // ---- host 半：TS → ESM，由 profile loader 作为包 main 加载。
  //      只允许 node 内置模块与 @deepseek-ai/cordis 类型，无外部运行时依赖。 ----
  {
    name: 'host',
    entry: { index: 'src/host/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2022',
    outExtension: () => ({ js: '.js' }),
    clean: true,
    sourcemap: false,
    dts: false,
  },
  // ---- client 半：TS → CJS，包裹在 loader 握手中 ----
  //      external 里放的都是「浏览器模块表在运行时提供的平台单例」，其余全部内联打包。
  //      `@deepseek-ai/dsh-client-ui-primitives` 必须列在这里：源码里的 require 是
  //      **字符串字面量**调用，esbuild 对它是会解析的（不像变量形式的动态 require），
  //      而本仓库没装这个包 → 解析失败直接炸构建。列成 external 后它既保持运行时的
  //      `require("@deepseek-ai/dsh-client-ui-primitives")`（loader 从模块表回答，
  //      见 `packages/client/web/src/seed.ts` 的 `PLATFORM_MODULES`），也不会被内联
  //      （那个包 400+ KB）。 ----
  {
    name: 'client',
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    target: 'es2020',
    external: ['react', '@deepseek-ai/dsh-client-ui-primitives'],
    outExtension: () => ({ js: '.js' }),
    clean: false,
    sourcemap: false,
    dts: false,
    banner: { js: CLIENT_BANNER },
    footer: { js: CLIENT_FOOTER },
    // 源码里的 `module.exports = {}` 是 loader 契约（上面的包裹提供了局部
    // `var module`），不是 ESM 误用——静默该警告。
    esbuildOptions: (options) => {
      options.logOverride = { 'commonjs-variable-in-esm': 'silent' }
    },
  },
])
