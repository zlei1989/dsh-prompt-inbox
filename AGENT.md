# AGENT.md

用中文交流。

## 约束

- **代码变更后、进入审查阶段前，必须先执行类型检查** — `pnpm typecheck`（即 `tsc --noEmit`），修复所有错误后再进入代码审查；本仓库无 ESLint/formatter 配置
- **host 半（`src/host/`）禁止引入 npm 运行时依赖** — 只能导入 node 内置模块与 `@deepseek-ai/cordis` 类型，其余全部内联打包；client 半（`src/client/`）唯一外部依赖是 `react`（浏览器平台模块表运行时提供，经 `src/client/react.ts` 单点引入）
- **修改 `src/` 后必须重新 `pnpm build`** — client 半被 DSH client-modules 按 bundle rev 缓存，构建后需重启 `dsh web`（仅 HMR 开发模式可热更）
- **host 与 client 不互相 import** — 二者运行在不同程序里，只能经 `src/shared/` 的类型约束、以纯 JSON 走 HTTP 路由通信
- **绝不添加 `export default apply`（host 半）** — Loader 的 unwrapExports 会把模块坍缩为裸函数并丢弃 `inject`，导致 `apply` 与服务纤程竞态

## 目录

```text
dsh-prompt-inbox/          # DSH 组合包（bundle），单包，pnpm 管理
├── src/
│   ├── host/       # Host 半：原生 Cordis 插件（动态工具/系统提示上下文/HTTP 路由/资产与日志存储），构建为 lib/index.js（ESM）
│   ├── client/     # Client 半：保存图标 + 草稿 tab + 最近草稿列表 + composer 适配层，构建为 lib/client.js（CJS + ModuleLoader 包裹）
│   └── shared/     # host ↔ client 经 HTTP 交换的纯 JSON 形状（type-only）
├── tests/          # node:test + tsx：tests/host/ 与 tests/client/，也纳入 typecheck
├── tsup.config.ts      # 双入口构建配置
├── cordis.patch.yml    # bundle 配置层：插入 name: dsh-prompt-inbox 行
└── lib/                # 构建产物，不入库
```

依赖方向：`host`/`client` → `shared`；host 与 client 互不依赖，运行时经 harness webserver 路由通信。

## 命令

| 命令 | 说明 |
|------|------|
| `pnpm install` | 安装依赖 |
| `pnpm build` | tsup 双入口构建（host→ESM，client→CJS+loader 包裹） |
| `pnpm watch` | tsup 持续构建 |
| `pnpm typecheck` | TypeScript 类型检查（`tsc --noEmit`） |
| `pnpm test` | `node --import tsx --test "tests/**/*.test.ts"`（**引号 glob 是必须的**：裸目录形式在本仓库会 exit 1） |
| `pnpm dsh plugin --profile web add .` | 装入 DSH `web` profile（详见 README.md） |

## 注释

| 规则 | 说明 |
|------|------|
| 风格 | TS 用 JSDoc；中文，简洁，先说"做什么"再说"怎么做" |
| 文件头 | 简要说明文件职责 + 注意事项 |
| 嵌套 > 2 层 | 必须注释业务含义 |
| 功能点 | 方法、条件分支、事件处理、数据转换等独立功能单元都需说明其业务目的和关键逻辑 |
| 重要方法 | 必须注释算法思路或业务逻辑 |
| 特殊处理 | 环境判断、响应处理等需注释原因 |
| 密度 | 同文件内保持一致 |

## 日志

| 级别 | 场景 |
|------|------|
| ERROR | 业务异常、外部调用失败 — 必须打印堆栈和业务上下文 |
| WARN | 降级、重试、超时、配置缺失但可继续 |
| INFO | 请求入口、关键状态变更、外部调用耗时 >500ms |
| DEBUG | 分支走向、中间变量、循环关键节点（生产默认关闭） |

**必须打日志的点位**：请求入口（INFO + 标识）、外部调用（DEBUG 参数 + INFO 耗时）、异常捕获（ERROR + 堆栈 + 上下文）、关键分支（DEBUG + 依据）

host 半的 DEBUG 由环境变量 `DSH_PROMPT_INBOX_DEBUG=1` 打开；client 半的 DEBUG 走 `console.debug`，DevTools 默认级别即不可见。

## 技术栈

- **语言/构建** — TypeScript（strict + `verbatimModuleSyntax`）+ tsup 双入口；`moduleResolution: Bundler`，无路径别名
- **Host 半** — Cordis 原生插件，`inject` 声明的服务就绪后运行；注册动态工具 `prompt_inbox_element`、元素快照系统提示上下文段、`/invoke` 与 `/asset` HTTP 路由；目标 `es2022` ESM
- **Client 半** — `window.__ModuleLoader__.load` 闭包工厂格式，`module.exports` 为插件表面；目标 `es2020`，`react` external
- **目标平台** — Windows；macOS/Linux 未验证
