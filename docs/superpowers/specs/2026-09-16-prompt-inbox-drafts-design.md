# 提示词草稿箱（prompt-inbox 草稿功能）设计

- 日期：2026-09-16
- 仓库：`D:\zhanglei1120\Github\dsh-prompt-inbox`
- 状态：待实施（本文档通过 review 后进入实施计划）

## 1. 目标

在 DSH Web GUI 里把「输入框里正在写的东西」整体存下来，之后能原样弹回输入框。

关键点是**「整体」**：不只是提示词文字，还包括文件/图片附件，以及
`dsh-webpage-element-picker` 写进正文的 `[DOMn]` 元素上下文。仅存文字会让草稿在
新会话里失去意义——模型能看到 `[DOMn]`，却查不到对应元素。

### 已确认的需求决策

| # | 决策 | 结论 |
|---|------|------|
| 1 | 草稿页位置 | 顶部第三个 tab：`对话 \| 轨迹 \| 草稿`（注册进 `conversation.view` 插槽） |
| 2 | 附件字节 | 存到旁路目录，`jsonl` 只存引用 |
| 3 | 元素上下文 | `[DOMn]` 元素信息随草稿快照；**当前只能拿到 `{id, pageUrl, label}` 摘要**，完整 payload 被插件边界挡住，见 §3.4 |
| 4 | 整体方案 | host 单一事实源 + client 现场快照（client 不持有副本） |
| 5 | 草稿库作用域 | 一份库，每条记录带来源会话；列表可展示全部会话的草稿并标注来源 |
| 6 | 记录字段 | 保留 `active` 与 `degraded` 两个字段 |
| 7 | 回弹冲突 | 输入框非空时弹二次确认；为空则直接回弹 |
| 8 | 保存入口 | `conversation.input.left` 槽位，形状对齐 `[完全权限]`，输入框有内容时才出现 |

### 非目标

- 不修改 DSH 源码；全部能力经已声明插槽与公开服务实现。
- 不做自动保存、不做草稿编辑（草稿不可改，只能回弹后改完再存新的）。
- 不做跨机器同步、不做草稿导入导出。
- 不做 `.dsh` 之外的位置（路径固定为 `$DSH_HOME`，见 §3）。

## 2. 架构

**不变量：composer 是 composer 状态的唯一所有者，host 是草稿内容的唯一所有者，
插件在 client 半不留任何副本。**

```
┌─ 浏览器 ────────────────────────────────────────────────┐
│ conversation.input.left ── SaveDraftButton              │  「有内容才出现」
│ conversation.view ──────── DraftView（tab 草稿）          │
│ conversation.input.dock ── DraftStrip（空会话时）         │  ← composer 下方
│                          └── composer-bridge ───────────┤  无状态：读一次/写一次
└──────────────────────────────┬──────────────────────────┘
                     POST /dsh-prompt-inbox/invoke（同源 fetch）
┌──────────────────────────────┴──────────────────────────┐
│ host: routes ── draft-service ── draft-store（jsonl）     │
│                       └────────── asset-store（旁路目录） │
│       element-snapshot + prompt_inbox_element 工具        │
└──────────────────────────────────────────────────────────┘
```

`element-snapshot` 是元素快照的**进程内激活集**：回弹某条草稿时把它的元素快照载入，
并在系统提示上下文段里列出来。`prompt_inbox_element` 工具按编号返回元素信息——
有完整 payload 就返回它，只有摘要时**明确回答「完整 payload 不可得」**并给出摘要，
不伪造字段（见 §3.4）。

### 为什么 client 不留副本

替代方案是在 client 半镜像 composer 状态（监听附件增删持续同步）。放弃它的原因：
那需要处理 add / remove / prune / 会话切换 / `draftRev` 冲突，正是 harness 自己在
`input/facade.ts` 里称之为 "THE complexity sink" 的一层。为一个保存按钮引入双份状态，
收益仅是自动保存——而自动保存不在本次目标内。现场快照每次只读一次、写一次，
失败就整次失败，用户看得见。

### 边界与依赖

| 边 | 内容 |
|---|---|
| 新增插槽注册 | `conversation.input.left`（保存图标）、`conversation.view`（草稿 tab）、`conversation.input.dock`（空会话草稿列表） |
| 读取的公开服务 | `ctx.slots`、`ctx.tools`、`ctx.systemPrompt`、`ctx.webServer`（host）；`ctx.get('conversation')`（client） |
| 跨插件读取 | `dsh-webpage-element-picker` 的 `/dsh-webpage-element-picker/invoke`，方法 `picker-context-list`（只读，返回摘要） |

`ctx.get('conversation')` 是 `ui-conversation` 自己 `provide` 的服务（见其
`apply.ts` 的 `concreteConversation()`），与插件读 `ctx.tools` 属同一类动作。
其中 `resolveDraftAttachments` / `createDrafts` / `addAttachments` 是
包内面而非文档化公开面：**这是本设计最大的工程脆弱点**（harness 升级可能让它失效），
与 §7-1 那个「功能缺口」是两件事，见 §7-2。

## 3. 数据模型与存储布局

### 3.1 草稿记录

```jsonc
{
  "id": "drf_7f3a91",                 // host 发号，时间有序
  "createdAt": 1789533068639,
  "originSessionId": "sess_ab12…",    // 来源会话
  "originLabel": "查询DSH任务队列插件", // 可选；客户端尽力解析，取不到显示 id 前缀
  "active": false,                    // 当前输入框内容是否来自它
  "content": {
    "text": "……[完全权限][DOM14]……",  // 原样保存，含 @ 引用与 [DOMn] 的字面形式
    "attachments": [
      {
        "name": "shot.png",
        "mediaType": "image/png",
        "size": 20480,
        "kind": "image",              // image | file
        "asset": { "sha256": "9f2c…", "ref": "sha256/9f/9f2c….bin" },
        "degraded": false
      }
    ],
    "elements": [
      {
        "id": "DOM14",
        "pageUrl": "http://127.0.0.1:3080/",     // 来自 picker 摘要
        "label": "完全权限",                      // 来自 picker 摘要
        "payload": null,                         // 完整 payload；当前取不到，见 §3.4
        "degraded": true                         // true = 只有摘要，没有选择器/HTML/尺寸
      }
    ]
  }
}
```

**`degraded` 是显式降级位**，两种成因：附件超上限时只留元信息（无 `asset`）；
元素取不到完整 payload 时只留摘要。降级必须被记录并在 UI 标注，
否则用户会以为草稿是完整的。

**`active`** 用于在列表里标出「哪条正是当前输入框里的」；回弹时置位，输入框被清空
（发送成功或手动清空）后复位。

### 3.2 `jsonl`：追加写的变更日志

`$DSH_HOME/prompt-inbox.jsonl`，一行一个变更：

```jsonc
{"op":"upsert","record":{ …完整记录… }}
{"op":"delete","id":"drf_7f3a91","at":1789533100000}
```

- 载入时按 `id` 折叠取最新一条；`delete` 是墓碑。
- 保存是纯追加，不必每次重写整个文件；删除也不必原地改。
- **压紧**：文件超过 500 条记录时重写为「当前状态全集」，走 `临时文件 + rename`，
  避免写坏。压紧只在启动与每次删除后检查，不在保存热路径上。

### 3.3 旁路资产目录

`$DSH_HOME/prompt-inbox-assets/sha256/<前2位>/<sha256>.bin`

按内容哈希命名，于是自动获得两个性质：

- **去重**：相同文件只存一份，跨草稿、跨会话。
- **引用计数**：删除草稿时扫一遍剩余记录，没有任何记录再引用该 hash 才 `unlink`。

`jsonl` 因此保持轻量、可读、可进 git；字节不进去。

### 3.4 元素来源：能力边界与适配层

**已核实的事实**（读 `dsh-webpage-element-picker` 源码，非推断）：该插件把
`domRegistry` 放在自己的 host 进程内存里，`/invoke` 只暴露 7 个方法，其中唯一能按
编号查询的是 `picker-context-list`，而它的返回类型 `ContextItemSummary` 只有
`{ domId, label, pageUrl }`，源码注释明确写着「不含大 payload」。完整 payload
（HTML / CSS 选择器 / DOM 路径 / 属性 / 位置尺寸）不经过任何路由。
`picker-pull` 是一次性排空待插入队列，`read_picked_element` 是它的 host 内部工具。

因此：**在只做插件的约束下，草稿拿不到元素完整 payload。**

设计上用「可插拔元素来源」把这条硬边界收进一个适配层，而不是假装它不存在：

| 来源 | 配置 | 拿到什么 |
|---|---|---|
| `picker-context-list`（默认，本次实现） | 无需配置 | `{ id, label, pageUrl }`，元素标 `degraded: true` |
| `elementGet`（若 picker 未来暴露按编号取 payload 的方法） | `dsh.promptInbox.elements = { url, elementGet }` | 完整 payload，`degraded: false` |
| 原始 CDP 读取 | 不实现 | —— |

适配层是一个 `ElementSource` 接口，唯一实现是默认的 `picker-context-list` 读取器。
`elementGet` 那条路径**本次只留接口与配置位，不实现**——没有可用的对端方法，
写了也无法验证。

**这对用户意味着什么（必须说清楚）**：回弹到新会话后，草稿正文里的 `[DOMn]`
仍然存在，插件也能告诉模型「DOM14 是 `完全权限`（来自 http://127.0.0.1:3080/）」，
但**选择器、HTML、尺寸这些细节拿不到**，模型只能拿到摘要。这与原始需求
「全部信息都应该保存」有差距，差距的成因在 picker 的插件边界，不在本插件。
补齐它需要二选一，均不在本次范围：

- 给 picker 加一个 `picker-element-get` 只读方法（约 10 行，但用户已声明不碰源码）；
- 插件自行开浏览器读原始 CDP（等于把 picker 的浏览器逻辑再做一遍，属重复建设）。

### 3.5 配置与上限

经 bundle 行的 `config` 提供，全部有默认值，用户可在自己 profile 的
`cordis.patch.yml` 里覆盖（patch 按 id 覆盖整行 config）：

| 键 | 默认 | 含义 |
|---|---|---|
| `maxAttachmentBytes` | `20971520`（20MB） | 超过则该附件降级为只存元信息 |
| `maxDraftBytes` | `52428800`（50MB） | 超过则整次保存失败并提示，不做部分成功 |
| `maxRecords` | `500` | jsonl 超过该条数即压紧 |
| `assetsDir` | `$DSH_HOME/prompt-inbox-assets` | 旁路资产目录 |
| `logPath` | `$DSH_HOME/prompt-inbox.jsonl` | 变更日志 |
| `elements.elementGet` | 未设置 | 元素完整 payload 来源，本次不实现（§3.4） |

### 3.6 `$DSH_HOME` 解析

按 harness 约定解析，与 `@deepseek-ai/dsh-home-paths` 的 `resolveDshHome` 一致：
显式配置 > `$DSH_HOME`（空白视为未设置）> `~/.dsh`。为守住「host 半不引入 npm
运行时依赖」的约束，这段逻辑在插件内本地实现（约 10 行，只用 `node:os` / `node:path`），
不 import 该包。

## 4. 三个动作

### 4.1 保存

点图标 → **一次** `POST /invoke`：

1. 现场读 `useInput(s => s.draft)` 取文字、`s.attachmentIds` 取附件 id 列表。
2. `conversation.resolveDraftAttachments(ids)` 取真实 `File`——唯一一次读包内面。
3. 正文正则扫 `\[(DOM\d+)\]`，逐个向 picker 的 `picker-context-list` 取摘要
   （完整 payload 取不到，见 §3.4）。
4. `File` → 字节 → `sha256` → base64，连同记录一起 POST。

**为什么合成一次调用**：host 先落资产、再追加记录，因此不会出现「记录存在但字节没写完」
的半成品；反过来若资产写完而记录追加失败，留下的只是孤儿资产，由 GC 清掉，
不产生坏草稿。

### 4.2 回弹

读完整记录（含资产读取 URL）→ 逐个取字节 → 重建 `File` →
`conversation.createDrafts(sessionId, files)` → `inputActions.addAttachments(ids)` →
`setDraft(text)` → 激活元素快照集 → 该条置 `active`。

- **顺序不可倒**：附件必须先于文字落位（`addAttachments` 在 busy 阶段会被拒），
  所以先塞附件再写文字。
- **冲突**：输入框非空时弹二次确认；确认为整段覆盖（`setDraft` 是整体替换语义，
  harness 自己在会话切换时也这么用）。
- 覆盖前不做自动备份——那会凭空多出草稿。

### 4.3 删除

追加 `delete` 墓碑 → 扫剩余记录算引用计数 → 归零的 sha256 才 `unlink`。

删除正在 `active` 的那条**不动输入框**：输入框里的内容不因为库里少了一条而消失。

### 4.4 再次保存

草稿不可改。回弹后改动再点保存 → **新建一条**（既有 harness id 发号，
`upsert` 也按 id 覆盖，等价）。原草稿保持原样，因此不会丢历史。

## 5. 失败处理

| 失败 | 行为 |
|---|---|
| `ctx.get('conversation')` 取不到 / 接口变形 | **整次保存失败**并明确报错。宁可存不下，也不静默存一份不完整的草稿 |
| 单个附件 > 上限（20MB） | 该附件标 `degraded`，只存元信息，UI 标注「未存字节」 |
| 取 picker 摘要失败（picker 未装/未开） | 该元素只留 `{ id }`，标 `degraded`，UI 标注 |
| 元素完整 payload 不可得（当前常态） | 元素标 `degraded`，只存摘要，UI 标注「仅摘要」，见 §3.4 |
| `jsonl` 写入失败 / 资产写入失败 | 整次保存失败，输入框原样不动 + 错误提示 |
| `jsonl` 载入遇到坏行 | 跳过该行并告警，其余记录照常可用（不整体崩） |
| 回弹时某资产文件丢失 | 跳过该附件、其余照常回弹，提示「N 个附件未能恢复」 |
| `webserver` 路由重复注册 | 沿用骨架的 catch：告警降级，UI 明确报不可用 |

所有失败路径都遵守本仓库 AGENT.md 的日志约定：ERROR 带堆栈与业务上下文，
WARN 用于降级/可继续，DEBUG 用于分支走向。

## 6. UI 与文案

- **保存图标**：`conversation.input.left`，形状对齐 `[完全权限]`；`draft.trim() !== ''`
  时出现，空则消失。tooltip「保存到草稿」（用户指定原文）。
- **草稿 tab**：标签「草稿」，`order` 排在 `轨迹` 之后。
- **列表项**：正文首行截断 + `N 个附件 · N 个元素` + 相对时间 + 来源会话标注 +
  「回弹」/「删除」按钮 + `degraded` 徽标。
- **默认过滤**：显示本会话草稿；顶部一个「全部会话」开关切到全部并逐条标注来源。
- **空会话列表**：`conversation.input.dock` 插槽在当前会话无草稿时回退显示最近的其他
  会话草稿。
- 不引入 locale 服务：直接写中文常量（本插件暂不做多语言），在 README 记录该取舍。

## 7. 已知风险与限制

1. **元素完整 payload 拿不到（原始需求缺口）**：成因见 §3.4，是
   `dsh-webpage-element-picker` 的插件边界，本插件在「不改 DSH 源码、不改其他插件」
   的约束下无法补齐。草稿能保存 `[DOMn]` 与来源摘要，但模型拿不到选择器/HTML/尺寸。
   这是本次交付与原始期望之间**最大的已知差距**，必须由用户确认接受或改变约束。
2. **包内面依赖**：`resolveDraftAttachments` / `createDrafts` /
   `addAttachments` 是 `ui-conversation` 的包内面。它一旦改名或变形，附件保存/回弹即失效。
   缓解：调用点集中在一个 `resolveComposer()` 适配函数里，运行时校验方法存在性，
   缺失时抛出明确错误（并把 §5 第一行作为行为），便于定位。升级 harness 后需复验。
3. **图片张数/体积上限**：恢复的附件仍受 composer 原有准入策略约束，超限时是发送被拒——
   与手动选 5 张图完全一致。插件不绕过 composer 的准入，这是有意的。
4. **`originLabel` 可能取不到**：会话标题解析失败时显示 id 前缀，不影响功能。
5. **同一进程加载两份本插件**：HTTP 路由冲突，后注册者失败；已在 §5 覆盖。
6. **草稿体积**：单草稿 50MB 上限；超限整次保存失败并提示，不做部分成功。

## 8. 测试与验证

### host 半（`node:test` + `tsx`，零新依赖）

- `draft-store`：追加 / 折叠最新 / 墓碑删除 / 500 条压紧 / 坏行不整体崩 /
  temp+rename 不留半截
- `asset-store`：同内容去重 / 引用计数 / 归零才 unlink
- `draft-service`：`[DOMn]` 提取 / `degraded` 判定 / 记录往返序列化
- `routes`：沿用本次骨架已验证的「mock Cordis 上下文 + 真实 `node:http`」手法，
  跑通 保存 → 列表 → 回弹 → 删除 全链路

### client 半

纯逻辑（记录 ↔ 信封转换、预览文本生成、`[DOMn]` 扫描）抽进无 DOM 依赖模块做单测；
UI 交互走人工清单。

### 端到端人工清单

1. 输入框有内容 → 图标出现；清空 → 消失
2. 点保存 → `~/.dsh/prompt-inbox.jsonl` 新增一行，`prompt-inbox-assets/` 出现字节
3. `草稿` tab 出现在 `轨迹` 右侧
4. 带**附件**的草稿在新会话回弹：附件栏原样恢复（含图片预览）
5. 带 `[DOMn]` 的草稿在新会话回弹：正文 `[DOMn]` 保留，模型经 `prompt_inbox_element`
   能读到摘要，且**明确回答完整 payload 不可得**（§3.4）
6. 输入框非空时回弹 → 弹二次确认
7. 删除草稿 → 资产被回收（引用归零）
8. `degraded` 附件/元素在 UI 上有明确标注

**可证伪检查**：保存后直接读 `~/.dsh/prompt-inbox.jsonl` 展示真实内容，而不是只声称「已保存」。

## 9. 后续（不在本次范围）

- 自动保存（需要 client 侧镜像，即被否掉的方案 C）
- 草稿重命名 / 打标签 / 搜索
- 草稿跨机器同步、导入导出
- **补齐元素完整 payload**（要缩小 §3.4 / §7-1 的差距，二选一）：
  - 给 picker 加一个 `picker-element-get` 只读方法，本插件随即启用
    `elementGet` 适配器——需要用户放开「不改其他插件」的约束；
  - 或本插件自行经 CDP 读取页面元素——重复建设，不推荐。
- 把 `[DOMn]` 回注到 picker，使回弹后的元素带上交互式 chip
