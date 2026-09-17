# dsh-prompt-inbox

DSH（DeepSeek Harness）**组合包**（bundle）：提示词草稿箱。把输入框里正在写的东西**整体**存下来——不只是文字，还包括附件与页面元素上下文——之后能弹回输入框继续用。

## 它是什么

在对话输入框左侧加一个「保存到草稿」图标（输入框有内容时才出现），并在顶部视图栏加一个 `草稿` tab：

- **保存**：把当前输入框的完整内容写进 `~/.dsh/prompt-inbox.jsonl`，附件字节写进旁路目录
  `~/.dsh/prompt-inbox-assets/`（内容寻址，同内容只存一份，删除时按引用计数回收）。
  **保存成功后输入框会被清空**（正文 + 附件），并通知草稿列表立即重拉；结果提示约 3.5 秒后自行消失。
  保存失败则一个字都不动——不落地就不清空。
- **回弹**：从列表里选一条草稿，把文字、附件、元素上下文一起放回输入框；输入框非空时先确认，
  避免静默覆盖正在写的内容。
- **模型面**：回弹后系统提示里会列出该草稿携带的 `[DOMn]` 元素，模型可调
  `prompt_inbox_element` 工具按编号读取。

草稿库是**一份**，每条记录带来源会话；`草稿` tab 默认只看本会话，可切「全部会话」，并逐条标注来源。
`草稿` tab 只在会话页存在，新会话（hero）页里它不挂载——所以新会话页把最近草稿列在输入框下方
（进入会话页后这一列整块收起，入口交回 tab）。**两个界面画的是同一张卡片**（`DraftCard`），
只是列表里默认折成一行：正文超出宽度时出省略号，点一下就地展开成完整卡片（正文、摘要与时间、
回弹、删除）。删除逐条二次确认；确认走设计系统的 `Modal`，
配色全部取自 `--dsw-alias-*` 语义 token，浅色/深色自动跟随。

反馈分两条通道：**动作成功走平台的 `Toast`**（顶部横幅，停留 3 秒后淡出，不占版面），
**失败与警告留在列表/面板上的行内提示**（要留在原地供人对照是哪一条出的问题）。

## 目录结构

```text
dsh-prompt-inbox/
├── src/
│   ├── host/                    # Host 半 → lib/index.js（ESM），Node 内置模块 + cordis 类型，无 npm 运行时依赖
│   │   ├── index.ts             # 插件入口：name / inject / apply（配置校验、装配、注册）
│   │   ├── home.ts              # $DSH_HOME 解析（显式配置 > $DSH_HOME > ~/.dsh）
│   │   ├── draft-store.ts       # jsonl 变更日志：折叠最新 / 墓碑 / 压紧 / 坏行只跳过
│   │   ├── asset-store.ts       # 内容寻址资产：sha256 分片、去重、引用计数回收
│   │   ├── element-source.ts    # 元素来源适配层（picker 摘要 + 显式降级）
│   │   ├── element-registry.ts  # 元素快照的进程内激活集
│   │   ├── draft-service.ts     # 领域服务：校验 / [DOMn] 提取 / 落资产 / 落记录 / 回收
│   │   ├── routes.ts            # /invoke 方法表 + /asset 字节路由（白名单先于 read）
│   │   ├── tools.ts             # prompt_inbox_element 工具 + 元素快照提示段
│   │   └── services.ts          # 消费的 harness host 服务契约（type-only）
│   ├── client/                  # Client 半 → lib/client.js（CJS + ModuleLoader 包裹）
│   │   ├── index.ts             # 插件入口：module.exports = { name, inject, apply }
│   │   ├── SaveDraftButton.ts   # conversation.input.left 的保存图标
│   │   ├── DraftView.ts         # conversation.view 的「草稿」tab
│   │   ├── DraftStrip.ts        # conversation.input.dock 的最近草稿列表
│   │   ├── DraftCard.ts         # 一条草稿卡片（上面两者共用；列表里可折叠成一行）
│   │   ├── toast-notice.ts      # 动作成功的瞬时提示（平台 Toast + 自增 seq 换 key）
│   │   ├── restore-action.ts    # 回弹动作（两个入口共用）+ 覆盖确认判定
│   │   ├── confirm-dialogs.ts   # 覆盖/删除确认对话框（平台 Modal + Button）
│   │   ├── list-scope.ts        # 纯逻辑：最近草稿列表只在新会话（hero）页显示
│   │   ├── active-draft.ts      # 「当前草稿」协调器：输入框清空时复位 active 与元素激活集
│   │   ├── composer-bridge.ts   # 唯一读 ui-conversation 包内面的地方（composer 适配层）
│   │   ├── draft-record.ts      # 纯逻辑：预览文本 / 摘要 / 会话徽标 / base64
│   │   ├── host-call.ts         # /invoke 与 /asset 的同源调用
│   │   ├── styles.ts            # 样式常量与注入（配色只走 --dsw-alias-* 语义 token）
│   │   ├── react.ts             # react 单点引入（浏览器模块表经 require 提供）
│   │   ├── primitives.ts        # ui-primitives 单点引入（同上，Modal/Button/图标）
│   │   └── services.ts          # 消费的 slots 服务与槽位 props 契约（type-only）
│   └── shared/types.ts          # 跨端交换的纯 JSON 形状（type-only）
├── tests/host/ · tests/client/  # node:test + tsx，173 条
├── cordis.patch.yml             # bundle 配置层：插入 name: dsh-prompt-inbox 行
├── tsup.config.ts               # 双入口构建（host→ESM / client→CJS+握手）
└── docs/superpowers/            # 设计 spec 与 10 任务实施计划
```

依赖方向：`host`/`client` → `shared`。host 与 client **互不 import**——它们跑在不同程序里，
只能以纯 JSON 走 HTTP 路由通信。

## 命令

```sh
pnpm install     # 安装依赖
pnpm build       # tsup 双入口构建
pnpm watch       # tsup 持续构建
pnpm typecheck   # tsc --noEmit（src 与 tests 都纳入）
pnpm test        # node --import tsx --test "tests/**/*.test.ts"
```

## 配置

全部可选，来自 bundle 行的 `config`，缺失用默认值、非法值告警后退回默认值。
（host 半不许引 npm 运行时依赖，而校验 schema 来自 npm 包，所以这里自己做等价校验，没有 schemastery。）

| 键 | 默认 | 含义 |
|---|---|---|
| `maxAttachmentBytes` | 20 MB | 单附件上限；超过则该附件降级为只存元信息 |
| `maxDraftBytes` | 50 MB | 单草稿字节上限；超过则整次保存失败 |
| `maxRecords` | 500 | 日志行数上限，超过即压紧 |
| `logPath` | `$DSH_HOME/prompt-inbox.jsonl` | 变更日志 |
| `assetsDir` | `$DSH_HOME/prompt-inbox-assets` | 旁路资产目录 |

## 安装进 profile

```sh
pnpm dsh plugin --profile web add "D:/zhanglei1120/Github/dsh-prompt-inbox"
pnpm dsh --profile web --dump-config   # 应出现 "# == dsh-prompt-inbox" 层与 prompt-inbox 行
```

随后**重启** `dsh web`。修改 `src/` 后必须重新 `pnpm build`：client 半被 DSH client-modules 按
bundle rev 缓存，构建后需重启才能生效（仅 HMR 开发模式可热更）。

卸载：`pnpm dsh plugin --profile web remove dsh-prompt-inbox`。

## 已知限制

写在这里不是免责，而是让使用者知道**哪些事它做不到**，别按做不到的预期去用。

1. **元素只有摘要，没有完整 payload。** `[DOMn]` 的 HTML / CSS 选择器 / DOM 路径 / 属性 /
   位置尺寸存在 `dsh-webpage-element-picker` 自己的 host 进程内存里，它的 `/invoke` 路由**不暴露**
   任何能按编号取 payload 的方法（唯一能查的 `picker-context-list` 只返回
   `{ domId, label, pageUrl }`，其源码注释写明「不含大 payload」）。
   所以在「不改 DSH 源码、不改其他插件」的约束下，草稿只能存下**编号 + 标签 + 来源页**，
   元素一律标 `degraded`。`prompt_inbox_element` 工具会如实回 `payloadAvailable: false` 并说明
   「完整 payload 被插件边界挡住，未保存」——**不会伪造字段**。要真正拿到完整 payload，
   需要给 picker 加一个只读取 payload 的方法（约 10 行），本插件已留好 `ElementSource` 适配位。
2. **「当前」标记与元素激活集只在输入框清空时复位，且依赖两个组件之一在挂载。** 回弹成功后
   记下「输入框里装着这条草稿」，输入框**变成空**（发送成功或手动清空）时由 client 发一次
   `draft-set-active { id: null }`，host 在同一次调用里复位 `active` 标志并清空元素激活集——
   两者是同一条不变量，不会再出现「徽标清了、提示段还在列旧编号」。三条已知边界：
   ①**改了但没清空**不会复位（编辑中的正文对应的仍是同一批 `[DOMn]`，徽标与元素集留到输入框真空为止）；
   ②清空是**边沿触发**的，只有 `DraftView` / `DraftStrip` 至少一个挂载着并因输入框变化重渲染时
   才发得出去——两个都没挂载时（既不在草稿 tab、当前会话也没有 dock 列表）这次复位没人发起；
   槽位没提供 `useInput` 时组件读不到输入框，这种「观测不到」按不动处理（**不**当成空，否则刚
   回弹激活的元素集会立刻被清掉）；
   ③元素激活集是**进程作用域**的（见 #4），所以一个会话里触发的复位会连带清掉另一个会话正在读的
   元素清单——方向是安全的（旧编号不再被断言），但它是会真实发生的行为。
   复位请求本身失败只留一条 ERROR 日志，不重试（重试点只能是下一次 composer 变化，会在每次
   按键上重发同一条失败请求），代价是状态可能停在旧值直到下一次回弹或进程重启。
3. **`originLabel` 没人写。** 类型上它是「来源会话展示名」，但保存时从不填，所以跨会话徽标
   退化成 8 位会话 id 前缀。
4. **元素激活集不按会话隔离。** 它以进程为作用域；多会话同时使用时，一个会话的系统提示可能列出
   另一个会话的 `[DOMn]`。
5. **单草稿的体积上限只管附件字节，不管正文文字。** 正文的实际上限是传输层
   `maxBodyBytes`（由 `maxDraftBytes` 推得，约 1 MB UTF-8 余量）。
6. **不接 locale 服务**：文案是中文常量，暂不做多语言。

## 尚未验证

以下都需要**真实浏览器 / 真实 profile**，本仓库的自动化测试覆盖不到（仓库只装了 `@types/react`，
没有 react 运行时，组件模块在 Node 里加载不了）。**已划掉的表示已在真机验收中走过一轮**
（2026-09-16，实例 3088），剩下的仍是未知：

- ~~`草稿` tab 是否真的出现在 `轨迹` 右侧、label 是否被读成文案~~（已验：`order: 20` 渲染在轨迹右侧）；
- ~~三个组件的渲染、可见性、确认对话框接线~~（已验：hero 显示 / 进入会话页整块收起、浅深两套主题的
  计算色与 `--dsw-alias-*` 解析值逐字相等、回弹与删除各自弹出 `[role="dialog"]`、取消后草稿仍在）；
- ~~槽位注册的 `inject` 工厂是否真的把 `ctx` 摊进 props~~（已由上面两项的可用性间接证实）；
- ~~保存后 `~/.dsh/prompt-inbox.jsonl` 是否真的多出一行~~（已验：多次保存各追加一行，正文与输入一致）；
- ~~共用卡片在 hero 列表里的折叠与展开~~（2026-09-17 已验，实例 3088：折成一行 26.4px 高、带内边距、
  正文超宽时真的出省略号且卡片不被顶破、点一下变成与 `草稿` tab 同款卡片并露出回弹/删除、
  回弹成功后保持展开并标上「当前」、删除仍走确认对话框；实测还改掉了两处：卡片字号在两个
  槽位解析值不同（12px vs 16px，已写死在卡片上）、以及正文行缺少 `min-width: 0` 导致长正文
  顶破卡片而不是截断）；
- ~~删除成功改用 toast~~（2026-09-17 已验，两个界面各一次：删除后弹出平台横幅
  `[role="alert"]`「已删除草稿」，`z-index: 1100`、顶部居中、约 4 秒后自行消失，
  全程 `.dsh-pi-notice` 那块常驻行**没有出现**；纯成功的回弹同样不弹空横幅）；
- **带附件的草稿回弹后附件栏是否原样恢复** —— 仍未验（此前只验过纯文字草稿）；
- **删除后资产文件是否真的被回收** —— 仍未验（`draft-remove` 的成功/失败提示已验，但资产目录的
  实际回收没看过）；
- **回弹后把输入框清空（发送或手动清空），列表里的「当前」徽标与系统提示里的 `[DOMn]` 清单
  是否真的消失**：协调器（`active-draft.ts`）的判定与闸门有单测，但从「输入框变空」到
  「发出复位请求」的那两次调用写在 `DraftView` / `DraftStrip` 的渲染路径上，组件在 Node 里
  加载不了，这一环只在真机上才算验证过。**2026-09-17 实测未通过**：输入框被清空后
  `contenteditable` 的 DOM 是 `<p><br></p>`，读出来的正文是 `"\n"`（不是空串，`textContent`
  才是空串），`hasComposerContent` 于是判为「还有内容」，复位请求不发、「当前」徽标一直留着。
  修法在 `composer-bridge.ts` 那一侧（判空前先 `trim()` 或读 `textContent`），与卡片复用无关，
  未在本轮改动；
- **`草稿` tab 面板在未选中时是否真的不挂载**（只有框架源码证据：
  `ConversationSession.tsx` 的 `{ only: active.id }`），因此 `noteComposerChange` 的无条件调用
  是复位能否触发的关键路径；
- **会话页里 `草稿` tab 的回弹对话框**（在输入框非空时）未实测——hero 侧与它共用同一组件与判定；
- **样式注入与卸载回收** —— 仍未验；
- **把构建产物装进真实 `web` profile 后重启两次**（重复注册 `webserver` 路由会走进
  `index.ts` 的 catch 分支，这条分支从未在真实 server 上跑过）—— 仍未验，且这是目前最值得做的一条。

以上都属**人工**验收，没有自动化回归——组件在 Node 里加载不了。验收清单见 spec 的 §8。


## 参考

- 设计 spec：`docs/superpowers/specs/2026-09-16-prompt-inbox-drafts-design.md`
- 实施计划：`docs/superpowers/plans/2026-09-16-prompt-inbox-drafts.md`

## License

MIT
