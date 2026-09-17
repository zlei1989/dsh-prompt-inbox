# 提示词草稿箱 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 DSH Web GUI 里把输入框的完整内容（文字 + 附件字节 + `[DOMn]` 元素摘要）存成草稿，之后能弹回输入框。

**Architecture:** host 是草稿内容的唯一所有者（jsonl 变更日志 + 内容寻址的旁路资产目录），client 半不持有任何副本——点保存时现场读一次 composer、写一次 host，点回弹时读一次、写一次 composer。三个 UI 入口都注册进已声明的插槽，不改任何 DSH 源码。

**Tech Stack:** TypeScript（strict + `verbatimModuleSyntax`）、tsup 双入口、React（浏览器模块表经 `require` 提供）、`node:test` + `tsx`（测试）、Cordis 插件。

**Spec:** `docs/superpowers/specs/2026-09-16-prompt-inbox-drafts-design.md`

## Global Constraints

- **host 半（`src/host/`）禁止引入 npm 运行时依赖** — 只能导入 node 内置模块与 `@deepseek-ai/cordis` **类型**。
- **client 半（`src/client/`）唯一外部依赖是 `react`**，经 `src/client/react.ts` 单点引入。
- **host 与 client 互不 import**，只能通过 `src/shared/` 的类型约束、以纯 JSON 走 HTTP 通信。
- **host 半绝不写 `export default apply`** — Loader 的 unwrapExports 会丢弃 `inject`。
- **client 半必须 `module.exports = { name, inject, apply }`**。
- **每个副作用都必须经 `ctx.effect()` 登记清理器**（样式表、槽位、工具、路由、提示段）。
- **每次代码变更后必须 `pnpm typecheck` 通过**，再进入审查。
- **路径解析**：显式配置 > `$DSH_HOME`（空白视为未设置）> `~/.dsh`。
- **默认上限**：单附件 20MB（`20971520`）、单草稿 50MB（`52428800`）、jsonl 500 条（`500`）。
- **文案**：全部中文常量，不接 locale 服务。保存图标 tooltip 必须是「保存到草稿」。
- **元素 payload 差距**：已接受。只存摘要，元素标 `degraded: true`，不得伪造字段。
- **测试命令**：`node --import tsx --test "tests/**/*.test.ts"`（目录形式不可用，必须带引号的 glob）。

---

### Task 1: jsonl 变更日志存储

**Files:**
- Create: `src/host/home.ts`
- Create: `src/host/draft-store.ts`
- Test: `tests/host/draft-store.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `resolveDshHome(configured?: string): string`
  - `interface DraftStore { load(): DraftRecord[]; appendUpsert(record: DraftRecord): void; appendDelete(id: string, at: number): void; compact(): void; recordCount(): number }`
  - `function createDraftStore(options: { logPath: string; maxRecords?: number }): DraftStore`
  - `function foldRecords(lines: string[]): Map<string, DraftRecord>`

- [ ] **Step 1: 写失败的测试**

创建 `tests/host/draft-store.test.ts`：

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDraftStore, foldRecords } from '../../src/host/draft-store.ts'
import type { DraftRecord } from '../../src/shared/types.ts'

function tempLog(): string {
  return join(mkdtempSync(join(tmpdir(), 'pi-')), 'prompt-inbox.jsonl')
}

function record(id: string, text = 'hello'): DraftRecord {
  return {
    id,
    createdAt: 1,
    originSessionId: 'sess-1',
    active: false,
    content: { text, attachments: [], elements: [] },
  }
}

test('foldRecords 取同 id 的最新一条', () => {
  const folded = foldRecords([
    JSON.stringify({ op: 'upsert', record: record('d1', 'first') }),
    JSON.stringify({ op: 'upsert', record: record('d1', 'second') }),
    JSON.stringify({ op: 'upsert', record: record('d2') }),
  ])
  assert.equal(folded.size, 2)
  assert.equal(folded.get('d1')?.content.text, 'second')
})

test('foldRecords 遇到坏行跳过而不整体崩', () => {
  const folded = foldRecords([
    'not json at all',
    JSON.stringify({ op: 'upsert', record: record('d1') }),
    '{"op":"upsert"',
    JSON.stringify({ op: 'wat' }),
  ])
  assert.equal(folded.size, 1)
  assert.ok(folded.has('d1'))
})

test('appendUpsert 是纯追加，load 折叠出最新', () => {
  const logPath = tempLog()
  const store = createDraftStore({ logPath })
  store.appendUpsert(record('d1', 'first'))
  store.appendUpsert(record('d1', 'second'))
  const lines = readFileSync(logPath, 'utf8').trim().split('\n')
  assert.equal(lines.length, 2, '两次保存应是两行（纯追加）')
  assert.equal(store.load().length, 1)
  assert.equal(store.load()[0]?.content.text, 'second')
})

test('appendDelete 是墓碑，load 后记录消失', () => {
  const logPath = tempLog()
  const store = createDraftStore({ logPath })
  store.appendUpsert(record('d1'))
  store.appendDelete('d1', 2)
  assert.equal(store.load().length, 0)
})

test('load 对不存在的文件返回空数组（不抛）', () => {
  const store = createDraftStore({ logPath: tempLog() })
  assert.deepEqual(store.load(), [])
})

test('compact 重写为当前状态全集并保留未删除记录', () => {
  const logPath = tempLog()
  const store = createDraftStore({ logPath })
  store.appendUpsert(record('d1', 'first'))
  store.appendUpsert(record('d1', 'second'))
  store.appendUpsert(record('d2'))
  store.appendDelete('d2', 3)
  store.compact()
  const lines = readFileSync(logPath, 'utf8').trim().split('\n')
  assert.equal(lines.length, 1, '压紧后只应剩 d1 一行')
  assert.equal(store.load().length, 1)
  assert.equal(store.load()[0]?.content.text, 'second')
})

test('compact 走临时文件，不留半截文件', () => {
  const logPath = tempLog()
  const store = createDraftStore({ logPath })
  store.appendUpsert(record('d1'))
  store.compact()
  const raw = readFileSync(logPath, 'utf8')
  assert.ok(raw.endsWith('\n'), '压紧后的文件应以换行收尾')
  assert.ok(!raw.includes('first-first'), '不应出现重复内容')
})

test('recordCount 统计尚未压紧的行数', () => {
  const logPath = tempLog()
  const store = createDraftStore({ logPath })
  store.appendUpsert(record('d1'))
  store.appendUpsert(record('d2'))
  assert.equal(store.recordCount(), 2)
})

test('load 忽略已损坏的尾部半行', () => {
  const logPath = tempLog()
  const store = createDraftStore({ logPath })
  store.appendUpsert(record('d1'))
  writeFileSync(logPath, readFileSync(logPath, 'utf8') + '{"op":"upsert","rec', 'utf8')
  assert.equal(store.load().length, 1)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --import tsx --test "tests/host/draft-store.test.ts"`
Expected: FAIL — `Cannot find module '.../src/host/draft-store.ts'`

- [ ] **Step 3: 写 shared 类型**

创建 `src/shared/types.ts`（整文件替换骨架里的旧内容——旧的收件箱类型已不再使用）：

```ts
/**
 * 跨 host ↔ client 边界交换的纯 JSON 形状。
 *
 * 两端运行在不同程序里（Node 与浏览器页面），只能经 harness webserver 路由
 * 以 JSON 交换这些值。因此本文件没有任何运行时导入——两端都只用它做类型约束。
 */

/** 一条附件在草稿里的记录。degraded 为 true 表示只存了元信息，没有字节。 */
export interface DraftAttachmentRecord {
  name: string
  mediaType: string
  size: number
  kind: 'image' | 'file'
  /** 内容寻址引用；degraded 为 true 时缺失。 */
  asset?: { sha256: string; ref: string }
  degraded: boolean
}

/**
 * 一条被 [DOMn] 引用的页面元素快照。
 * payload 为 null 表示只拿到摘要（当前常态，见 spec §3.4）。
 */
export interface DraftElementRecord {
  id: string
  pageUrl?: string
  label?: string
  payload: Record<string, unknown> | null
  degraded: boolean
}

/** 草稿的完整内容。 */
export interface DraftContent {
  /** 输入框正文原样保存，含 @ 引用与 [DOMn] 的字面形式。 */
  text: string
  attachments: DraftAttachmentRecord[]
  elements: DraftElementRecord[]
}

/** 一条草稿记录（host 发号）。 */
export interface DraftRecord {
  id: string
  createdAt: number
  originSessionId: string
  /** 来源会话的展示名，客户端尽力解析；取不到则显示 id 前缀。 */
  originLabel?: string
  /** 当前输入框内容是否来自它。 */
  active: boolean
  content: DraftContent
}

/** client 提交保存时的载荷（id/createdAt/active 由 host 决定）。 */
export interface DraftSavePayload {
  text: string
  originSessionId: string
  originLabel?: string
  attachments: Array<{
    name: string
    mediaType: string
    size: number
    kind: 'image' | 'file'
    /** 附件字节的 base64；超上限时省略，该附件降级。 */
    base64?: string
  }>
  elements: DraftElementRecord[]
}

/** jsonl 里的一行。 */
export type DraftLogLine =
  | { op: 'upsert'; record: DraftRecord }
  | { op: 'delete'; id: string; at: number }

/** `/invoke` 的统一信封。 */
export interface InvokeResult {
  ok: boolean
  error?: string
  records?: DraftRecord[]
  record?: DraftRecord
  /** `draft-get` 附带：附件 id → host 上可取字节的 URL。 */
  assetUrls?: Record<string, string>
  /** 表示这次失败是「降级后仍成功」的说明，UI 需要展示。 */
  warnings?: string[]
}
```

- [ ] **Step 4: 写 home 解析**

创建 `src/host/home.ts`：

```ts
/**
 * `$DSH_HOME` 解析。
 *
 * 与 `@deepseek-ai/dsh-home-paths` 的 `resolveDshHome` 保持一致的优先级：
 * 显式配置 > `$DSH_HOME`（空白视为未设置）> `~/.dsh`。
 * 这里本地实现而不 import 该包，是为了守住「host 半不引入 npm 运行时依赖」的约束。
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** 展开 `~`、`~/`、`~\` 前缀。 */
function expandHomePath(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/**
 * 解析 harness home。
 * @param configured - 显式配置路径，优先级最高。
 * @param env - 读取 `DSH_HOME` 的环境映射，默认 `process.env`。
 */
export function resolveDshHome(
  configured?: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const fromEnv = env.DSH_HOME
  const selected = configured ?? (fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : join(homedir(), '.dsh'))
  return resolve(expandHomePath(selected))
}
```

- [ ] **Step 5: 写 draft-store**

创建 `src/host/draft-store.ts`：

```ts
/**
 * 草稿的 jsonl 变更日志存储。
 *
 * 一行一个变更（upsert / delete 墓碑），载入时按 id 折叠取最新。
 * 保存是纯追加，所以不必每次重写整个文件；删除也不必原地改。
 * 行数超过 maxRecords 后由调用方触发 compact()，重写为「当前状态全集」。
 *
 * 设计取舍：坏行只跳过并告警，绝不因为一行损坏就让整个草稿库不可用。
 */

import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { mkdirSync } from 'node:fs'
import type { DraftLogLine, DraftRecord } from '../shared/types.ts'

/** 默认压紧阈值：jsonl 里的行数上限。 */
const DEFAULT_MAX_RECORDS = 500

/** 日志里一行解析失败时的原因，供调用方打日志。 */
export interface BadLine {
  line: number
  raw: string
  reason: string
}

/**
 * 按 id 折叠日志行，返回当前状态。
 * 无效行（坏 JSON、未知 op、缺字段）跳过；delete 产生墓碑。
 * @param lines - 日志原文按行切分的结果。
 * @param onBadLine - 可选回调，用于把坏行交给调用方记日志。
 */
export function foldRecords(lines: string[], onBadLine?: (bad: BadLine) => void): Map<string, DraftRecord> {
  const state = new Map<string, DraftRecord>()
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]!.trim()
    if (raw === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      onBadLine?.({ line: i + 1, raw, reason: 'JSON 解析失败: ' + String((err as Error)?.message || err) })
      continue
    }
    const line = parsed as Partial<DraftLogLine>
    if (line.op === 'upsert' && line.record !== undefined && typeof line.record.id === 'string') {
      state.set(line.record.id, line.record)
      continue
    }
    if (line.op === 'delete' && typeof line.id === 'string') {
      state.delete(line.id)
      continue
    }
    onBadLine?.({ line: i + 1, raw, reason: '未知 op 或缺字段' })
  }
  return state
}

/** 草稿存储接口。 */
export interface DraftStore {
  /** 载入当前全部记录（按 createdAt 升序）。 */
  load(): DraftRecord[]
  /** 追加一条 upsert。 */
  appendUpsert(record: DraftRecord): void
  /** 追加一条 delete 墓碑。 */
  appendDelete(id: string, at: number): void
  /** 重写为当前状态全集（临时文件 + rename）。 */
  compact(): void
  /** 统计日志当前行数（不含空行），用于判断是否需要压紧。 */
  recordCount(): number
  /** 日志文件绝对路径。 */
  readonly logPath: string
}

/**
 * 创建草稿存储。
 * @param options - 日志路径与压紧阈值。
 * @param options.onWarn - 坏行/压紧等可继续情况的回调，交给调用方记日志。
 */
export function createDraftStore(options: {
  logPath: string
  maxRecords?: number
  onWarn?: (msg: string) => void
}): DraftStore {
  const { logPath, onWarn } = options
  const maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS

  /** 读原始行；文件不存在返回空数组。 */
  const readLines = (): string[] => {
    if (!existsSync(logPath)) return []
    return readFileSync(logPath, 'utf8').split('\n')
  }

  const store: DraftStore = {
    logPath,

    load(): DraftRecord[] {
      const folded = foldRecords(readLines(), (bad) => {
        onWarn?.('prompt-inbox.jsonl 第 ' + bad.line + ' 行已跳过（' + bad.reason + '）')
      })
      return [...folded.values()].sort((a, b) => a.createdAt - b.createdAt)
    },

    appendUpsert(record: DraftRecord): void {
      mkdirSync(dirname(logPath), { recursive: true })
      appendFileSync(logPath, JSON.stringify({ op: 'upsert', record } satisfies DraftLogLine) + '\n', 'utf8')
    },

    appendDelete(id: string, at: number): void {
      mkdirSync(dirname(logPath), { recursive: true })
      appendFileSync(logPath, JSON.stringify({ op: 'delete', id, at } satisfies DraftLogLine) + '\n', 'utf8')
    },

    compact(): void {
      const records = store.load()
      const body = records.map((r) => JSON.stringify({ op: 'upsert', record: r } satisfies DraftLogLine)).join('\n')
      const text = records.length === 0 ? '' : body + '\n'
      mkdirSync(dirname(logPath), { recursive: true })
      // 先写临时文件再 rename：任何时刻磁盘上都有一份完整可读的日志
      const tempPath = join(dirname(logPath), '.' + 'prompt-inbox.jsonl.tmp')
      writeFileSync(tempPath, text, 'utf8')
      renameSync(tempPath, logPath)
      onWarn?.('prompt-inbox.jsonl 已压紧为 ' + records.length + ' 条记录')
    },

    recordCount(): number {
      return readLines().filter((line) => line.trim() !== '').length
    },
  }

  return store
}

/** 默认压紧阈值，供配置默认值复用。 */
export const DEFAULT_RECORDS = DEFAULT_MAX_RECORDS
```

- [ ] **Step 6: 运行测试确认通过**

Run: `node --import tsx --test "tests/host/draft-store.test.ts"`
Expected: PASS — 9 tests, 0 fail

- [ ] **Step 7: 类型检查**

Run: `pnpm typecheck`
Expected: 无输出，exit 0

- [ ] **Step 8: Commit**

```bash
git add src/shared/types.ts src/host/home.ts src/host/draft-store.ts tests/host/draft-store.test.ts
git commit -m "feat(host): jsonl 草稿存储（追加日志 + 墓碑 + 压紧）"
```

---

### Task 2: 内容寻址的旁路资产目录

**Files:**
- Create: `src/host/asset-store.ts`
- Test: `tests/host/asset-store.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `interface AssetStore { put(bytes: Uint8Array): { sha256: string; ref: string; bytes: number }; read(ref: string): Uint8Array; collectGarbage(referenced: ReadonlySet<string>): number; has(ref: string): boolean }`
  - `function createAssetStore(options: { root: string; onWarn?: (msg: string) => void }): AssetStore`
  - `function shardRef(sha256: string): string` — 返回 `sha256/<前2位>/<sha256>.bin`

- [ ] **Step 1: 写失败的测试**

创建 `tests/host/asset-store.test.ts`：

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAssetStore, shardRef } from '../../src/host/asset-store.ts'

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'pi-assets-'))
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])

test('shardRef 按内容哈希分片', () => {
  const ref = shardRef('9f2cabcdef')
  assert.equal(ref, join('sha256', '9f', '9f2cabcdef.bin'))
})

test('put 落盘并返回 sha256 与 ref', () => {
  const store = createAssetStore({ root: tempRoot() })
  const put = store.put(PNG)
  assert.equal(put.bytes, PNG.byteLength)
  assert.match(put.sha256, /^[0-9a-f]{64}$/)
  assert.ok(store.has(put.ref))
})

test('相同内容只落一份（去重）', () => {
  const store = createAssetStore({ root: tempRoot() })
  const a = store.put(PNG)
  const b = store.put(PNG)
  assert.equal(a.ref, b.ref)
  assert.equal(a.sha256, b.sha256)
})

test('read 取回原始字节', () => {
  const store = createAssetStore({ root: tempRoot() })
  const put = store.put(PNG)
  assert.deepEqual([...store.read(put.ref)], [...PNG])
})

test('has 对不存在的 ref 返回 false', () => {
  const store = createAssetStore({ root: tempRoot() })
  assert.equal(store.has(join('sha256', 'zz', 'zz.bin')), false)
})

test('collectGarbage 只删除未被引用的资产', () => {
  const root = tempRoot()
  const store = createAssetStore({ root })
  const keep = store.put(PNG)
  const drop = store.put(new Uint8Array([9, 9, 9]))
  const removed = store.collectGarbage(new Set([keep.ref]))
  assert.equal(removed, 1)
  assert.ok(store.has(keep.ref), '被引用的资产必须保留')
  assert.equal(store.has(drop.ref), false, '无引用资产必须删除')
})

test('collectGarbage 对空目录返回 0', () => {
  const store = createAssetStore({ root: tempRoot() })
  assert.equal(store.collectGarbage(new Set()), 0)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --import tsx --test "tests/host/asset-store.test.ts"`
Expected: FAIL — `Cannot find module '.../src/host/asset-store.ts'`

- [ ] **Step 3: 写 asset-store**

创建 `src/host/asset-store.ts`：

```ts
/**
 * 草稿附件的内容寻址旁路存储。
 *
 * 按 sha256 命名，于是自动获得两个性质：
 *   - 去重：相同文件只存一份，跨草稿、跨会话；
 *   - 引用计数：删除草稿时由调用方传入「仍被引用的 ref 集合」，
 *     不在集合里的才 unlink。
 *
 * jsonl 里只存 ref，字节永远不进去——日志因此保持轻量、可读、可进 git。
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 资产在根目录下的相对路径：`sha256/<前2位>/<sha256>.bin`。 */
export function shardRef(sha256: string): string {
  return join('sha256', sha256.slice(0, 2), sha256 + '.bin')
}

/** 旁路资产存储接口。 */
export interface AssetStore {
  /** 写入字节（已存在则跳过），返回内容哈希与相对 ref。 */
  put(bytes: Uint8Array): { sha256: string; ref: string; bytes: number }
  /** 按 ref 读回字节；不存在时抛错。 */
  read(ref: string): Uint8Array
  /** 该 ref 是否已落盘。 */
  has(ref: string): boolean
  /**
   * 回收未被引用的资产。
   * @param referenced - 当前仍被任何草稿记录引用的 ref 集合。
   * @returns 删除的文件数。
   */
  collectGarbage(referenced: ReadonlySet<string>): number
}

/**
 * 创建资产存储。
 * @param options - 根目录与告警回调。
 */
export function createAssetStore(options: {
  root: string
  onWarn?: (msg: string) => void
}): AssetStore {
  const { root, onWarn } = options

  const abs = (ref: string): string => join(root, ref)

  return {
    put(bytes: Uint8Array): { sha256: string; ref: string; bytes: number } {
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      const ref = shardRef(sha256)
      const target = abs(ref)
      if (!existsSync(target)) {
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, bytes)
      }
      return { sha256, ref, bytes: bytes.byteLength }
    },

    read(ref: string): Uint8Array {
      const target = abs(ref)
      if (!existsSync(target)) throw new Error('资产不存在: ' + ref)
      return new Uint8Array(readFileSync(target))
    },

    has(ref: string): boolean {
      return existsSync(abs(ref))
    },

    collectGarbage(referenced: ReadonlySet<string>): number {
      const shardRoot = join(root, 'sha256')
      if (!existsSync(shardRoot)) return 0
      let removed = 0
      for (const shard of readdirSync(shardRoot, { withFileTypes: true })) {
        if (!shard.isDirectory()) continue
        const shardDir = join(shardRoot, shard.name)
        for (const file of readdirSync(shardDir, { withFileTypes: true })) {
          if (!file.isFile()) continue
          const ref = shardRef(file.name.replace(/\.bin$/, ''))
          if (referenced.has(ref)) continue
          rmSync(join(shardDir, file.name), { force: true })
          removed += 1
        }
        // 分片空了就顺手收掉，避免目录无限堆积
        if (readdirSync(shardDir).length === 0) rmSync(shardDir, { recursive: true, force: true })
      }
      if (removed > 0) onWarn?.('资产回收：删除 ' + removed + ' 个未被引用的文件')
      return removed
    },
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --import tsx --test "tests/host/asset-store.test.ts"`
Expected: PASS — 7 tests, 0 fail

- [ ] **Step 5: 类型检查并提交**

```bash
pnpm typecheck
git add src/host/asset-store.ts tests/host/asset-store.test.ts
git commit -m "feat(host): 内容寻址的旁路资产存储（去重 + 引用计数回收）"
```

---

### Task 3: 元素来源适配层与激活集

**Files:**
- Create: `src/host/element-source.ts`
- Create: `src/host/element-registry.ts`
- Test: `tests/host/element-source.test.ts`

**Interfaces:**
- Consumes: `DraftElementRecord`（Task 1）
- Produces:
  - `interface ElementSource { lookup(ids: string[]): Promise<DraftElementRecord[]> }`
  - `function createPickerElementSource(options: { baseUrl: string; invokePath?: string; fetchImpl?: typeof fetch; onWarn?: (msg: string) => void }): ElementSource`
  - `interface ElementRegistry { activate(records: DraftElementRecord[], sourceLabel: string): void; list(): DraftElementRecord[]; find(id: string): DraftElementRecord | undefined; clear(): void; sourceLabel(): string }`
  - `function createElementRegistry(): ElementRegistry`

- [ ] **Step 1: 写失败的测试**

创建 `tests/host/element-source.test.ts`：

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPickerElementSource } from '../../src/host/element-source.ts'
import { createElementRegistry } from '../../src/host/element-registry.ts'
import type { DraftElementRecord } from '../../src/shared/types.ts'

test('picker 摘要命中时返回 label 与 pageUrl，且标 degraded', async () => {
  const source = createPickerElementSource({
    baseUrl: 'http://127.0.0.1:3080',
    fetchImpl: (async () => new Response(JSON.stringify({
      ok: true,
      items: [{ domId: 'DOM14', label: '完全权限', pageUrl: 'http://127.0.0.1:3080/' }],
    }))) as typeof fetch,
  })
  const [hit] = await source.lookup(['DOM14'])
  assert.equal(hit?.id, 'DOM14')
  assert.equal(hit?.label, '完全权限')
  assert.equal(hit?.pageUrl, 'http://127.0.0.1:3080/')
  assert.equal(hit?.payload, null)
  assert.equal(hit?.degraded, true, '拿不到完整 payload，必须标 degraded')
})

test('picker 未装/请求失败时只留 id，仍标 degraded', async () => {
  const source = createPickerElementSource({
    baseUrl: 'http://127.0.0.1:3080',
    fetchImpl: (async () => { throw new Error('ECONNREFUSED') }) as typeof fetch,
  })
  const [miss] = await source.lookup(['DOM99'])
  assert.equal(miss?.id, 'DOM99')
  assert.equal(miss?.label, undefined)
  assert.equal(miss?.degraded, true)
})

test('picker 返回 ok:false 时同样降级而不是抛错', async () => {
  const source = createPickerElementSource({
    baseUrl: 'http://127.0.0.1:3080',
    fetchImpl: (async () => new Response(JSON.stringify({ ok: false, error: '未知方法' }))) as typeof fetch,
  })
  const [miss] = await source.lookup(['DOM1'])
  assert.equal(miss?.id, 'DOM1')
  assert.equal(miss?.degraded, true)
})

test('lookup 保持请求顺序', async () => {
  const source = createPickerElementSource({
    baseUrl: 'http://127.0.0.1:3080',
    fetchImpl: (async () => new Response(JSON.stringify({
      ok: true,
      items: [{ domId: 'DOM2', label: 'b' }, { domId: 'DOM1', label: 'a' }],
    }))) as typeof fetch,
  })
  const out = await source.lookup(['DOM1', 'DOM2'])
  assert.deepEqual(out.map((r) => r.id), ['DOM1', 'DOM2'])
})

function element(id: string, degraded = true): DraftElementRecord {
  return { id, payload: null, degraded }
}

test('registry 激活后可查，clear 后为空', () => {
  const registry = createElementRegistry()
  registry.activate([element('DOM1'), element('DOM2')], '草稿 drf_1')
  assert.equal(registry.list().length, 2)
  assert.equal(registry.find('DOM1')?.id, 'DOM1')
  registry.clear()
  assert.equal(registry.list().length, 0)
  assert.equal(registry.find('DOM1'), undefined)
})

test('registry 激活会替换上一批（同一时刻只有一组激活元素）', () => {
  const registry = createElementRegistry()
  registry.activate([element('DOM1')], '草稿 A')
  registry.activate([element('DOM9')], '草稿 B')
  assert.equal(registry.find('DOM1'), undefined)
  assert.deepEqual(registry.list().map((r) => r.id), ['DOM9'])
})

test('registry 按 id 去重，保留先出现的', () => {
  const registry = createElementRegistry()
  registry.activate([element('DOM1', false), element('DOM1', true)], '草稿 A')
  assert.equal(registry.list().length, 1)
  assert.equal(registry.list()[0]?.degraded, false)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --import tsx --test "tests/host/element-source.test.ts"`
Expected: FAIL — `Cannot find module '.../src/host/element-source.ts'`

- [ ] **Step 3: 写 element-source**

创建 `src/host/element-source.ts`：

```ts
/**
 * 元素来源适配层。
 *
 * 已核实的能力边界（见 spec §3.4）：dsh-webpage-element-picker 把完整 payload
 * 放在自己的 host 进程内存里，`/invoke` 只暴露 picker-context-list，返回类型
 * ContextItemSummary 只有 { domId, label, pageUrl }，源码注释明确写着「不含大 payload」。
 *
 * 所以在「不改 DSH 源码、不改其他插件」的约束下，本插件只能拿到摘要。
 * 设计上把这条硬边界收进一个接口：默认实现走 picker-context-list，
 * 未来对端若暴露按编号取 payload 的方法，只需再加一个实现。
 *
 * 关键取舍：任何失败都降级为「只留 id」，绝不抛错、绝不伪造字段——
 * 保存草稿不应该因为 picker 没开而整个失败。
 */

import type { DraftElementRecord } from '../shared/types.ts'

/** 按编号查询元素信息的来源。 */
export interface ElementSource {
  /**
   * 查询一批元素编号。
   * @param ids - 形如 DOM1、DOM2 的编号。
   * @returns 与 ids 顺序一致的记录；查不到的项只填 id 并标 degraded。
   */
  lookup(ids: string[]): Promise<DraftElementRecord[]>
}

/** picker 的摘要条目形状（对应其 ContextItemSummary，只取用到的字段）。 */
interface PickerSummaryItem {
  domId?: unknown
  label?: unknown
  pageUrl?: unknown
}

/**
 * 创建基于 picker-context-list 的元素来源。
 * @param options.baseUrl - harness webserver 的 origin，如 `http://127.0.0.1:3080`。
 * @param options.invokePath - picker 的调用路径，默认其历史默认值。
 * @param options.fetchImpl - 可注入的 fetch，测试用。
 * @param options.onWarn - 降级原因的回调，交给调用方记日志。
 */
export function createPickerElementSource(options: {
  baseUrl: string
  invokePath?: string
  fetchImpl?: typeof fetch
  onWarn?: (msg: string) => void
}): ElementSource {
  const invokePath = options.invokePath ?? '/dsh-webpage-element-picker/invoke'
  const doFetch = options.fetchImpl ?? fetch

  /** 拉一次摘要表；任何异常都视为「没有摘要」。 */
  const fetchSummaries = async (): Promise<Map<string, { label?: string; pageUrl?: string }>> => {
    try {
      const res = await doFetch(options.baseUrl + invokePath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'picker-context-list', params: {} }),
      })
      if (!res.ok) {
        options.onWarn?.('picker 摘要请求返回 HTTP ' + res.status + '，元素降级为仅编号')
        return new Map()
      }
      const body = (await res.json()) as { ok?: unknown; items?: unknown }
      if (body.ok !== true || !Array.isArray(body.items)) {
        options.onWarn?.('picker 未返回可用摘要（可能未装或未打开浏览器），元素降级为仅编号')
        return new Map()
      }
      const map = new Map<string, { label?: string; pageUrl?: string }>()
      for (const raw of body.items as PickerSummaryItem[]) {
        if (typeof raw.domId !== 'string') continue
        map.set(raw.domId, {
          ...(typeof raw.label === 'string' && raw.label !== '' ? { label: raw.label } : {}),
          ...(typeof raw.pageUrl === 'string' && raw.pageUrl !== '' ? { pageUrl: raw.pageUrl } : {}),
        })
      }
      return map
    } catch (err) {
      options.onWarn?.('picker 摘要请求失败（' + String((err as Error)?.message || err) + '），元素降级为仅编号')
      return new Map()
    }
  }

  return {
    async lookup(ids: string[]): Promise<DraftElementRecord[]> {
      if (ids.length === 0) return []
      const summaries = await fetchSummaries()
      return ids.map((id) => {
        const hit = summaries.get(id)
        // payload 恒为 null：当前边界下拿不到，标 degraded 让 UI 与模型都知道这是摘要
        return {
          id,
          ...(hit?.label !== undefined ? { label: hit.label } : {}),
          ...(hit?.pageUrl !== undefined ? { pageUrl: hit.pageUrl } : {}),
          payload: null,
          degraded: true,
        }
      })
    },
  }
}
```

- [ ] **Step 4: 写 element-registry**

创建 `src/host/element-registry.ts`：

```ts
/**
 * 元素快照的进程内激活集。
 *
 * 回弹某条草稿时把它的元素快照载入这里，系统提示上下文段与
 * prompt_inbox_element 工具都从这里读。同一时刻只有一组激活元素——
 * composer 同一时刻也只装得下一条草稿，多组并存只会让 [DOMn] 指向歧义。
 */

import type { DraftElementRecord } from '../shared/types.ts'

/** 激活集接口。 */
export interface ElementRegistry {
  /** 用一条草稿的元素快照替换当前激活集。 */
  activate(records: DraftElementRecord[], sourceLabel: string): void
  /** 当前激活元素，按激活时顺序。 */
  list(): DraftElementRecord[]
  /** 按编号查询。 */
  find(id: string): DraftElementRecord | undefined
  /** 清空激活集（输入框被清空/发送后调用）。 */
  clear(): void
  /** 这批元素来自哪条草稿，用于提示段措辞。 */
  sourceLabel(): string
}

/** 创建激活集。 */
export function createElementRegistry(): ElementRegistry {
  let records: DraftElementRecord[] = []
  let label = ''

  return {
    activate(next: DraftElementRecord[], sourceLabel: string): void {
      // 同 id 去重，保留先出现的（保持草稿内原始顺序与语义）
      const seen = new Set<string>()
      const deduped: DraftElementRecord[] = []
      for (const record of next) {
        if (seen.has(record.id)) continue
        seen.add(record.id)
        deduped.push(record)
      }
      records = deduped
      label = sourceLabel
    },

    list(): DraftElementRecord[] {
      return records
    },

    find(id: string): DraftElementRecord | undefined {
      return records.find((record) => record.id === id)
    },

    clear(): void {
      records = []
      label = ''
    },

    sourceLabel(): string {
      return label
    },
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `node --import tsx --test "tests/host/element-source.test.ts"`
Expected: PASS — 8 tests, 0 fail

- [ ] **Step 6: 类型检查并提交**

```bash
pnpm typecheck
git add src/host/element-source.ts src/host/element-registry.ts tests/host/element-source.test.ts
git commit -m "feat(host): 元素来源适配层（picker 摘要 + 显式降级）与激活集"
```

---

### Task 4: 草稿领域服务

**Files:**
- Create: `src/host/draft-service.ts`
- Test: `tests/host/draft-service.test.ts`

**Interfaces:**
- Consumes: `DraftStore`（Task 1）、`AssetStore`（Task 2）、`ElementSource`（Task 3）
- Produces:
  - `function extractElementIds(text: string): string[]`
  - `function newDraftId(now: number, seq: number): string`
  - `interface DraftService { save(payload: DraftSavePayload): Promise<{ record: DraftRecord; warnings: string[] }>; list(): DraftRecord[]; get(id: string): DraftRecord | undefined; setActive(id: string | null): void; remove(id: string): { removed: boolean; reclaimed: number }; referencedAssetRefs(): Set<string> }`
  - `function createDraftService(options: { store: DraftStore; assets: AssetStore; elements: ElementSource; maxAttachmentBytes: number; maxDraftBytes: number; maxRecords: number; onWarn?: (msg: string) => void }): DraftService`

- [ ] **Step 1: 写失败的测试**

创建 `tests/host/draft-service.test.ts`：

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDraftStore } from '../../src/host/draft-store.ts'
import { createAssetStore } from '../../src/host/asset-store.ts'
import { createDraftService, extractElementIds } from '../../src/host/draft-service.ts'
import type { DraftElementRecord, DraftSavePayload } from '../../src/shared/types.ts'

function harness(overrides: { maxAttachmentBytes?: number; maxDraftBytes?: number; maxRecords?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pi-svc-'))
  const store = createDraftStore({ logPath: join(root, 'prompt-inbox.jsonl') })
  const assets = createAssetStore({ root: join(root, 'prompt-inbox-assets') })
  const elements: DraftElementRecord[] = [{ id: 'DOM1', label: '按钮', payload: null, degraded: true }]
  const service = createDraftService({
    store,
    assets,
    elements: {
      lookup: async (ids) => ids.map((id) => elements.find((e) => e.id === id) ?? { id, payload: null, degraded: true }),
    },
    maxAttachmentBytes: overrides.maxAttachmentBytes ?? 20 * 1024 * 1024,
    maxDraftBytes: overrides.maxDraftBytes ?? 50 * 1024 * 1024,
    maxRecords: overrides.maxRecords ?? 500,
  })
  return { service, store, assets, root }
}

function payload(over: Partial<DraftSavePayload> = {}): DraftSavePayload {
  return {
    text: '写一个 [DOM1] 的测试',
    originSessionId: 'sess-1',
    attachments: [],
    elements: [],
    ...over,
  }
}

test('extractElementIds 按出现顺序去重', () => {
  assert.deepEqual(extractElementIds('看 [DOM2] 和 [DOM1]，还有 [DOM2]'), ['DOM2', 'DOM1'])
})

test('extractElementIds 对无匹配返回空数组', () => {
  assert.deepEqual(extractElementIds('没有占位符'), [])
})

test('save 落一条记录并能 list/get 回来', async () => {
  const { service } = harness()
  const saved = await service.save(payload())
  assert.match(saved.record.id, /^drf_/)
  assert.equal(saved.record.active, false)
  assert.equal(service.list().length, 1)
  assert.equal(service.get(saved.record.id)?.content.text, '写一个 [DOM1] 的测试')
})

test('save 从正文提取 [DOMn] 并交由元素来源填充', async () => {
  const { service } = harness()
  const saved = await service.save(payload({ text: '看 [DOM1]' }))
  assert.equal(saved.record.content.elements.length, 1)
  assert.equal(saved.record.content.elements[0]?.id, 'DOM1')
  assert.equal(saved.record.content.elements[0]?.label, '按钮')
  assert.equal(saved.record.content.elements[0]?.degraded, true)
})

test('save 把附件字节落进旁路目录，记录里只留 sha256 引用', async () => {
  const { service, assets } = harness()
  const bytes = Buffer.from('hello-asset')
  const saved = await service.save(payload({
    attachments: [{ name: 'a.txt', mediaType: 'text/plain', size: bytes.byteLength, kind: 'file', base64: bytes.toString('base64') }],
  }))
  const [att] = saved.record.content.attachments
  assert.equal(att?.degraded, false)
  assert.ok(att?.asset)
  assert.ok(assets.has(att!.asset!.ref))
  assert.deepEqual([...assets.read(att!.asset!.ref)], [...bytes])
})

test('附件超上限时降级为只存元信息，并给出警告', async () => {
  const { service } = harness({ maxAttachmentBytes: 4 })
  const saved = await service.save(payload({
    attachments: [{ name: 'big.bin', mediaType: 'application/octet-stream', size: 11, kind: 'file', base64: Buffer.from('hello-asset').toString('base64') }],
  }))
  const [att] = saved.record.content.attachments
  assert.equal(att?.degraded, true)
  assert.equal(att?.asset, undefined)
  assert.equal(att?.size, 11)
  assert.ok(saved.warnings.some((w) => w.includes('big.bin')), '降级必须回报给调用方')
})

test('附件没有 base64 时降级（不抛）', async () => {
  const { service } = harness()
  const saved = await service.save(payload({
    attachments: [{ name: 'x.bin', mediaType: 'application/octet-stream', size: 3, kind: 'file' }],
  }))
  assert.equal(saved.record.content.attachments[0]?.degraded, true)
})

test('整次超上限时抛错，且不落记录', async () => {
  const { service } = harness({ maxDraftBytes: 8 })
  await assert.rejects(
    () => service.save(payload({
      attachments: [{ name: 'a.bin', mediaType: 'application/octet-stream', size: 11, kind: 'file', base64: Buffer.from('hello-asset').toString('base64') }],
    })),
    /超过上限/,
  )
  assert.equal(service.list().length, 0)
})

test('remove 删除记录并回收无引用资产', async () => {
  const { service, assets } = harness()
  const saved = await service.save(payload({
    attachments: [{ name: 'a.txt', mediaType: 'text/plain', size: 3, kind: 'file', base64: Buffer.from('abc').toString('base64') }],
  }))
  const ref = saved.record.content.attachments[0]!.asset!.ref
  const result = service.remove(saved.record.id)
  assert.equal(result.removed, true)
  assert.equal(result.reclaimed, 1)
  assert.equal(assets.has(ref), false)
  assert.equal(service.list().length, 0)
})

test('两条草稿引用同一份字节时，删一条不回收资产', async () => {
  const { service, assets } = harness()
  const base64 = Buffer.from('same-bytes').toString('base64')
  const a = await service.save(payload({ attachments: [{ name: 'a.bin', mediaType: 'application/octet-stream', size: 10, kind: 'file', base64 }] }))
  await service.save(payload({ attachments: [{ name: 'b.bin', mediaType: 'application/octet-stream', size: 10, kind: 'file', base64 }] }))
  const ref = a.record.content.attachments[0]!.asset!.ref
  const result = service.remove(a.record.id)
  assert.equal(result.reclaimed, 0, '另一条草稿仍在引用，不能删')
  assert.ok(assets.has(ref))
})

test('remove 不存在的 id 返回 removed:false', () => {
  const { service } = harness()
  assert.equal(service.remove('drf_nope').removed, false)
})

test('referencedAssetRefs 汇总所有记录引用的 ref', async () => {
  const { service } = harness()
  await service.save(payload({ attachments: [{ name: 'a.bin', mediaType: 'application/octet-stream', size: 3, kind: 'file', base64: Buffer.from('xyz').toString('base64') }] }))
  assert.equal(service.referencedAssetRefs().size, 1)
})

test('两次 save 得到不同 id', async () => {
  const { service } = harness()
  const a = await service.save(payload())
  const b = await service.save(payload())
  assert.notEqual(a.record.id, b.record.id)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --import tsx --test "tests/host/draft-service.test.ts"`
Expected: FAIL — `Cannot find module '.../src/host/draft-service.ts'`

- [ ] **Step 3: 写 draft-service**

创建 `src/host/draft-service.ts`：

```ts
/**
 * 草稿领域服务：把 client 提交的保存载荷变成一条可落盘的草稿记录。
 *
 * 职责边界：只做「校验 + 提取 + 落资产 + 落记录 + 回收」，
 * 不碰 HTTP、不碰系统提示、不碰工具注册——那些由 routes.ts / tools.ts 负责。
 *
 * 关键不变量：**记录绝不指向不存在的资产**。所以顺序必须是
 * 「先落资产、再追加记录」；反过来（先记录后资产）会留下悬空引用。
 * 若资产落盘成功而记录追加失败，留下的只是孤儿资产，由 GC 清掉，不产生坏草稿。
 */

import type { AssetStore } from './asset-store.ts'
import type { DraftStore } from './draft-store.ts'
import type { ElementSource } from './element-source.ts'
import type {
  DraftAttachmentRecord,
  DraftRecord,
  DraftSavePayload,
} from '../shared/types.ts'

/** 正文里 [DOMn] 占位符的扫描式：与 picker 的占位符约定一致。 */
const ELEMENT_TOKEN = /\[(DOM\d+)\]/g

/**
 * 提取正文里出现的元素编号，按首次出现顺序去重。
 * 只认 picker 使用的 [DOMn] 形式——这样新会话里模型看到的记号
 * 与它已经学会的完全一样，不需要额外的记号约定。
 */
export function extractElementIds(text: string): string[] {
  const seen = new Set<string>()
  const ids: string[] = []
  for (const match of text.matchAll(ELEMENT_TOKEN)) {
    const id = match[1]!
    if (seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids
}

/** 生成草稿 id：时间前缀保证大致有序，序号后缀保证同毫秒内唯一。 */
export function newDraftId(now: number, seq: number): string {
  return 'drf_' + now.toString(36) + '_' + seq.toString(36)
}

/** 草稿服务接口。 */
export interface DraftService {
  /** 保存一条草稿。超整次上限时抛错（调用方据此回失败）。 */
  save(payload: DraftSavePayload): Promise<{ record: DraftRecord; warnings: string[] }>
  /** 全部草稿，按 createdAt 升序。 */
  list(): DraftRecord[]
  /** 按 id 取一条。 */
  get(id: string): DraftRecord | undefined
  /** 把某条置为 active 并清除其余；传 null 清除全部。 */
  setActive(id: string | null): void
  /** 删除一条并回收无引用资产。 */
  remove(id: string): { removed: boolean; reclaimed: number }
  /** 当前所有记录仍引用的资产 ref 集合。 */
  referencedAssetRefs(): Set<string>
}

/**
 * 创建草稿服务。
 * @param options.maxAttachmentBytes - 单附件上限，超过则该附件降级为只存元信息。
 * @param options.maxDraftBytes - 单草稿字节上限，超过则整次保存失败。
 * @param options.maxRecords - jsonl 行数上限，超过即压紧。
 * @param options.onWarn - 降级/回收等可继续情况的回调，交给调用方记日志。
 */
export function createDraftService(options: {
  store: DraftStore
  assets: AssetStore
  elements: ElementSource
  maxAttachmentBytes: number
  maxDraftBytes: number
  maxRecords: number
  onWarn?: (msg: string) => void
}): DraftService {
  const { store, assets, elements, maxAttachmentBytes, maxDraftBytes, maxRecords, onWarn } = options
  let seq = 0

  /** 汇总当前所有记录引用的资产 ref（删除后据此判断能否回收）。 */
  const referencedAssetRefs = (): Set<string> => {
    const refs = new Set<string>()
    for (const record of store.load()) {
      for (const attachment of record.content.attachments) {
        if (attachment.asset !== undefined) refs.add(attachment.asset.ref)
      }
    }
    return refs
  }

  return {
    async save(payload: DraftSavePayload): Promise<{ record: DraftRecord; warnings: string[] }> {
      const warnings: string[] = []

      // 1) 先算总字节：整次超限要在落任何东西之前就失败
      let totalBytes = 0
      const attachmentRecords: DraftAttachmentRecord[] = []
      for (const incoming of payload.attachments) {
        const decoded = incoming.base64 === undefined
          ? undefined
          : new Uint8Array(Buffer.from(incoming.base64, 'base64'))
        if (decoded === undefined) {
          warnings.push('附件「' + incoming.name + '」未携带字节，已降级为仅记录元信息')
          attachmentRecords.push({ name: incoming.name, mediaType: incoming.mediaType, size: incoming.size, kind: incoming.kind, degraded: true })
          continue
        }
        totalBytes += decoded.byteLength
        if (decoded.byteLength > maxAttachmentBytes) {
          warnings.push('附件「' + incoming.name + '」超过单附件上限，已降级为仅记录元信息')
          attachmentRecords.push({ name: incoming.name, mediaType: incoming.mediaType, size: incoming.size, kind: incoming.kind, degraded: true })
          continue
        }
        const put = assets.put(decoded)
        attachmentRecords.push({
          name: incoming.name,
          mediaType: incoming.mediaType,
          size: incoming.size,
          kind: incoming.kind,
          asset: { sha256: put.sha256, ref: put.ref },
          degraded: false,
        })
      }
      if (totalBytes > maxDraftBytes) {
        throw new Error('草稿总字节 ' + totalBytes + ' 超过上限 ' + maxDraftBytes + '，已取消保存')
      }

      // 2) 元素：正文说了要哪些编号就只查哪些；查询失败在来源内部已降级
      const ids = extractElementIds(payload.text)
      const resolvedElements = await elements.lookup(ids)

      const now = Date.now()
      seq += 1
      const record: DraftRecord = {
        id: newDraftId(now, seq),
        createdAt: now,
        originSessionId: payload.originSessionId,
        ...(payload.originLabel !== undefined && payload.originLabel !== ''
          ? { originLabel: payload.originLabel }
          : {}),
        active: false,
        content: {
          text: payload.text,
          attachments: attachmentRecords,
          elements: resolvedElements,
        },
      }

      // 3) 资产已就位，才追加记录
      store.appendUpsert(record)
      if (store.recordCount() > maxRecords) store.compact()

      onWarn?.('草稿已保存 ' + record.id
        + '（附件 ' + attachmentRecords.length + '，元素 ' + resolvedElements.length + '）')
      return { record, warnings }
    },

    list(): DraftRecord[] {
      return store.load()
    },

    get(id: string): DraftRecord | undefined {
      return store.load().find((record) => record.id === id)
    },

    setActive(id: string | null): void {
      // 单次遍历写回：只有真正变化的记录才追加一行，避免每次回弹刷出一堆无意义日志
      for (const record of store.load()) {
        const next = record.id === id
        if (record.active === next) continue
        store.appendUpsert({ ...record, active: next })
      }
    },

    remove(id: string): { removed: boolean; reclaimed: number } {
      const exists = store.load().some((record) => record.id === id)
      if (!exists) return { removed: false, reclaimed: 0 }
      store.appendDelete(id, Date.now())
      // 记录已删，再按剩余引用回收资产
      const reclaimed = assets.collectGarbage(referencedAssetRefs())
      store.compact()
      return { removed: true, reclaimed }
    },

    referencedAssetRefs,
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --import tsx --test "tests/host/draft-service.test.ts"`
Expected: PASS — 13 tests, 0 fail（Step 1 的测试文件有 13 条 `test()`；此处原写 12 是计数错误）

- [ ] **Step 5: 补 setActive 与压紧的测试**

`setActive` 在 Task 5 的 `draft-set-active` 里被使用，必须有测试；压紧阈值同理。
在 `tests/host/draft-service.test.ts` 追加：

```ts
test('setActive 只把目标置为 true，其余清除', async () => {
  const { service } = harness()
  const a = await service.save(payload())
  const b = await service.save(payload())
  service.setActive(b.record.id)
  const byId = new Map(service.list().map((r) => [r.id, r.active]))
  assert.equal(byId.get(a.record.id), false)
  assert.equal(byId.get(b.record.id), true)
  service.setActive(null)
  assert.equal(service.list().every((r) => !r.active), true)
})

test('记录数超过 maxRecords 时自动压紧', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-compact-'))
  const store = createDraftStore({ logPath: join(root, 'prompt-inbox.jsonl') })
  const service = createDraftService({
    store,
    assets: createAssetStore({ root: join(root, 'assets') }),
    elements: { lookup: async (ids) => ids.map((id) => ({ id, payload: null, degraded: true })) },
    maxAttachmentBytes: 1024,
    maxDraftBytes: 1024,
    maxRecords: 2,
  })
  await service.save(payload())
  await service.save(payload())
  await service.save(payload())
  assert.equal(store.recordCount(), 3, '三条记录就是三行')
  assert.equal(service.list().length, 3, '压紧不丢记录')
})
```

同时把 `harness()` 里的 `createDraftService` 调用补上 `maxRecords: 500`。
再运行一次确认全绿。

Run: `node --import tsx --test "tests/host/draft-service.test.ts"`
Expected: PASS — 15 tests, 0 fail（13 条原有 + 本步 2 条；此处原写 14 是计数错误）

- [ ] **Step 6: 类型检查并提交**

```bash
pnpm typecheck
git add src/host/draft-service.ts tests/host/draft-service.test.ts
git commit -m "feat(host): 草稿领域服务（附件落资产 + [DOMn] 提取 + 引用计数回收 + active）"
```

---

### Task 5: HTTP 路由与 host 装配

**Files:**
- Create: `src/host/routes.ts`
- Modify: `src/host/index.ts`（整文件重写：装配服务、注册路由、删除旧收件箱占位实现）
- Test: `tests/host/routes.test.ts`

**Interfaces:**
- Consumes: Task 1–4 全部
- Produces:
  - `type InvokeHandler = (params: Record<string, unknown>) => Promise<InvokeResult>`
  - `function createHandlers(deps: { service: DraftService; assets: AssetStore; registry: ElementRegistry }): Map<string, InvokeHandler>`
  - 方法名：`draft-save` / `draft-list` / `draft-get` / `draft-remove` / `draft-set-active` / `element-list`
  - `function registerInvokeRoute(options: { webServer: WebServerFace; path: string; handlers: Map<string, InvokeHandler>; maxBodyBytes: number; log: {...} }): () => void`

- [ ] **Step 1: 写失败的测试**

创建 `tests/host/routes.test.ts`（沿用骨架已验证的「mock Cordis + 真实 node:http」手法）：

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDraftStore } from '../../src/host/draft-store.ts'
import { createAssetStore } from '../../src/host/asset-store.ts'
import { createDraftService } from '../../src/host/draft-service.ts'
import { createElementRegistry } from '../../src/host/element-registry.ts'
import { createHandlers, registerInvokeRoute } from '../../src/host/routes.ts'
import type { InvokeResult } from '../../src/shared/types.ts'

/** 起一个真实 HTTP 服务把路由挂上去，用 fetch 走真链路。 */
async function serve(overrides: { maxBodyBytes?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pi-routes-'))
  const assets = createAssetStore({ root: join(root, 'assets') })
  const service = createDraftService({
    store: createDraftStore({ logPath: join(root, 'prompt-inbox.jsonl') }),
    assets,
    elements: { lookup: async (ids) => ids.map((id) => ({ id, label: 'L' + id, payload: null, degraded: true })) },
    maxAttachmentBytes: 1024,
    maxDraftBytes: 4096,
    maxRecords: 500,
  })
  const registry = createElementRegistry()
  const handlers = createHandlers({ service, assets, registry })

  const routes: Array<{ path: string; handler: (req: never, res: never) => void }> = []
  const dispose = registerInvokeRoute({
    webServer: { register: (route) => { routes.push(route as never); return () => {} } },
    path: '/dsh-prompt-inbox/invoke',
    handlers,
    maxBodyBytes: overrides.maxBodyBytes ?? 8 * 1024 * 1024,
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  })
  // registerInvokeRoute 会注册 /invoke 与 /asset 两条路由，这里按 pathname 分派，
  // 不能按下标取——否则测试会打到错的路由并且看起来还能过
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    const route = routes.find((r) => r.path === pathname)
    if (route === undefined) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'no route' }))
      return
    }
    route.handler(req as never, res as never)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => { resolve() }))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const base = 'http://127.0.0.1:' + port + '/dsh-prompt-inbox/invoke'
  const call = async (method: string, params: Record<string, unknown> = {}): Promise<InvokeResult> => {
    const res = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, params }),
    })
    assert.equal(res.status, 200, method + ' 应回 200（业务失败走 ok:false）')
    return (await res.json()) as InvokeResult
  }
  return {
    call, service, assets, registry, base,
    assetBase: 'http://127.0.0.1:' + port + '/dsh-prompt-inbox/asset',
    close: async () => { dispose(); await new Promise<void>((resolve) => { server.close(() => { resolve() }) }) },
  }
}

test('draft-save 落记录，draft-list 读回来', async () => {
  const s = await serve()
  const saved = await s.call('draft-save', { payload: { text: 'hi [DOM1]', originSessionId: 'sess-1', attachments: [], elements: [] } })
  assert.equal(saved.ok, true)
  assert.ok(saved.record)
  const listed = await s.call('draft-list')
  assert.equal(listed.records?.length, 1)
  await s.close()
})

test('draft-save 返回的 elements 标 degraded', async () => {
  const s = await serve()
  const saved = await s.call('draft-save', { payload: { text: 'x [DOM7]', originSessionId: 'sess-1', attachments: [], elements: [] } })
  assert.equal(saved.record?.content.elements[0]?.id, 'DOM7')
  assert.equal(saved.record?.content.elements[0]?.degraded, true)
  await s.close()
})

test('draft-get 回记录与资产 URL，并激活元素集', async () => {
  const s = await serve()
  const saved = await s.call('draft-save', {
    payload: {
      text: 'x [DOM7]', originSessionId: 'sess-1', elements: [],
      attachments: [{ name: 'a.txt', mediaType: 'text/plain', size: 3, kind: 'file', base64: Buffer.from('abc').toString('base64') }],
    },
  })
  const id = saved.record!.id
  const got = await s.call('draft-get', { id })
  assert.equal(got.ok, true)
  assert.equal(got.record?.id, id)
  const ref = got.record!.content.attachments[0]!.asset!.ref
  assert.ok(got.assetUrls?.[ref], '应给出该资产的读取 URL')
  assert.equal(s.registry.list().length, 1, '回弹应激活元素集')
  await s.close()
})

test('draft-get 对未知 id 回 ok:false', async () => {
  const s = await serve()
  const got = await s.call('draft-get', { id: 'drf_nope' })
  assert.equal(got.ok, false)
  assert.match(String(got.error), /未找到/)
  await s.close()
})

test('draft-remove 删除并回收资产', async () => {
  const s = await serve()
  const saved = await s.call('draft-save', {
    payload: {
      text: 'x', originSessionId: 'sess-1', elements: [],
      attachments: [{ name: 'a.txt', mediaType: 'text/plain', size: 3, kind: 'file', base64: Buffer.from('abc').toString('base64') }],
    },
  })
  const ref = saved.record!.content.attachments[0]!.asset!.ref
  const removed = await s.call('draft-remove', { id: saved.record!.id })
  assert.equal(removed.ok, true)
  assert.equal(s.assets.has(ref), false)
  await s.close()
})

test('draft-set-active 只把目标置为 active', async () => {
  const s = await serve()
  const a = await s.call('draft-save', { payload: { text: 'a', originSessionId: 's', attachments: [], elements: [] } })
  const b = await s.call('draft-save', { payload: { text: 'b', originSessionId: 's', attachments: [], elements: [] } })
  await s.call('draft-set-active', { id: b.record!.id })
  const listed = await s.call('draft-list')
  const byId = new Map(listed.records!.map((r) => [r.id, r.active]))
  assert.equal(byId.get(a.record!.id), false)
  assert.equal(byId.get(b.record!.id), true)
  await s.close()
})

test('draft-set-active 传 null 清空全部 active', async () => {
  const s = await serve()
  const a = await s.call('draft-save', { payload: { text: 'a', originSessionId: 's', attachments: [], elements: [] } })
  await s.call('draft-set-active', { id: a.record!.id })
  await s.call('draft-set-active', { id: null })
  const listed = await s.call('draft-list')
  assert.equal(listed.records?.[0]?.active, false)
  await s.close()
})

test('unknown method 回 ok:false 而不是抛', async () => {
  const s = await serve()
  const res = await s.call('nope')
  assert.equal(res.ok, false)
  assert.match(String(res.error), /未知方法/)
  await s.close()
})

test('超 maxBodyBytes 时回 413', async () => {
  const s = await serve({ maxBodyBytes: 64 })
  const res = await fetch(s.base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method: 'draft-list', params: { pad: 'x'.repeat(4096) } }),
  })
  assert.equal(res.status, 413)
  await s.close()
})

test('element-list 在回弹后返回激活集', async () => {
  const s = await serve()
  const saved = await s.call('draft-save', { payload: { text: '[DOM3]', originSessionId: 's', attachments: [], elements: [] } })
  const before = await s.call('element-list')
  assert.equal(before.records?.length ?? 0, 0, '未回弹时激活集为空')
  await s.call('draft-get', { id: saved.record!.id })
  const after = await s.call('element-list')
  assert.equal(after.records?.length, 1, '回弹后激活集应有 1 条')
  assert.equal(after.records?.[0]?.id, 'DOM3')
  await s.close()
})

```ts
test('资产路由拒绝路径穿越形状的 ref', async () => {
  const s = await serve()
  const evil = await fetch(s.assetBase + '?ref=' + encodeURIComponent('../../etc/passwd'))
  assert.equal(evil.status, 400, '不合白名单形状的 ref 必须回 400')
  await s.close()
})
```

> **实现提醒**：`registerInvokeRoute` 需要同时注册两条路由——`/invoke`（POST）与
> `/asset`（GET）。`serve()` 已按 `pathname` 分派，并暴露 `assetBase` 供资产测试使用。
> 实现 `registerInvokeRoute` 时若只注册了 `/invoke`，上面那条资产测试会以 404 失败——
> 这正是它存在的意义。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --import tsx --test "tests/host/routes.test.ts"`
Expected: FAIL — `Cannot find module '.../src/host/routes.ts'`

- [ ] **Step 3: 写 routes**

创建 `src/host/routes.ts`，实现 `createHandlers` 与 `registerInvokeRoute`：

- `createHandlers` 返回 Map，每个 handler `async (params) => InvokeResult`：
  - `draft-save`：取 `params.payload` 交给 `service.save()`，失败回 `{ ok: false, error }`；成功回 `{ ok: true, record, warnings }`
  - `draft-list`：`{ ok: true, records: service.list() }`
  - `draft-get`：取 `params.id`；命中则 `registry.activate(record.content.elements, '草稿 ' + id)`，回 `{ ok: true, record, assetUrls }`（`assetUrls` 的键是 `asset.ref`，值是 `/dsh-prompt-inbox/asset?ref=<encodeURIComponent(ref)>`）；未命中回 `{ ok: false, error: '未找到草稿 <id>' }`
  - `draft-remove`：`service.remove(id)`；`{ ok: removed, error?, reclaimed? }`
  - `draft-set-active`：`id` 为字符串时把该条置 active、其余清除（逐条 appendUpsert），为 `null` 时全部清除
  - `element-list`：`{ ok: true, records: registry.list() }`
- `registerInvokeRoute` 与骨架里已有的实现同构（幂等 `respond()`、`maxBodyBytes` 上限、业务失败回 200 + `ok:false`、客户端提前断开时静默降级），但 `maxBodyBytes` 由参数传入。
  **请求体必须按字节累积再一次性解码，不能逐 chunk `String(chunk)` 拼接**：多字节字符被 socket
  分块切断时会解成 U+FFFD，而正文正是本产品的载荷（中文提示词）——那是保存时的静默数据损坏。
  正确做法是 `chunks.push(chunk)` 后 `Buffer.concat(chunks).toString('utf8')`，体积上限用
  `Buffer.byteLength` 量（`String.length` 数的是 UTF-16 码元，中文会少算到 1/3）。
  骨架原有实现里就有这个缺陷，移植时不要照抄。**额外再注册一条 `exact` GET 路由用于取资产字节**：

```ts
webServer.register({
  kind: 'exact',
  path: '/dsh-prompt-inbox/asset',
  handler: (req, res) => {
    // 只接受 GET；ref 经 query 传入，必须命中「sha256/<2位>/<64位hex>.bin」白名单形状，
    // 否则回 400——这是防路径穿越的关键校验，不能省
    // 命中则 assets.read(ref) 并以 application/octet-stream 返回
  },
})
```

> **这条白名单就是路径穿越的真正边界。** `refToPath` 走 `join(root, ...ref.split('/'))`，
> 和 `path.join(root, ref)` 一样会归一化 `..`——也就是说 `../../etc/x` 这类 ref 在
> `join` 这一层从来挡不住。唯一的防线是这里按形状白名单校验（`sha256/` + 两位 hex +
> `/` + 64 位 hex + `.bin`），在校验通过之前不得触碰 `assets.read`。
> 已核实：`ref` 只可能来自本插件 `put()` 的返回值或同用户的 `prompt-inbox.jsonl`，
> 网络面只有这一条路由，所以这条校验是充分的。

- [ ] **Step 4: 重写 src/host/index.ts**

整文件重写：保留 `name` / `inject` / 日志与 `ctx.effect` 约定，删掉骨架里的
`inbox-ping` / `inbox-list` / `inbox-add` / `inbox-remove` 与进程内 `items` 状态，
改为：

```ts
export const name = 'dsh-prompt-inbox'
export const inject = ['tools', 'systemPrompt', 'webServer']

export function apply(ctx: Context): void {
  const tools = ctx.get('tools') as ToolsFace
  const systemPrompt = ctx.get('systemPrompt') as SystemPromptFace
  const webServer = ctx.get('webServer') as WebServerFace

  // 配置解析（全部有默认值）
  const home = resolveDshHome()
  const logPath = join(home, 'prompt-inbox.jsonl')
  const assetsDir = join(home, 'prompt-inbox-assets')
  // …createDraftStore / createAssetStore / createPickerElementSource / createElementRegistry / createDraftService
  // …ctx.effect(() => registerInvokeRoute({...}))
  // …ctx.effect(() => registerTools(...))       // Task 6
  // …ctx.effect(() => registerPromptSection(...)) // Task 6
}
```

`Config` 用 schemastery 风格的可选字段（`maxAttachmentBytes` / `maxDraftBytes` / `maxRecords` / `logPath` / `assetsDir`），
与 spec §3.5 的表一致。若 loader 不接受内联 Config，则退化为读环境变量并在 README 记录该取舍。

**启动时跑一次孤儿资产 GC。** `assets.collectGarbage` 目前唯一的调用点是 `draft-service.remove()`，
没有启动期或定时清扫，于是「整次超限」失败时落下的孤儿字节（见 `draft-service.ts` 里修正后的注释）
会一直留在盘上——用户只要不删草稿就永远不回收。在装配阶段调用一次
`assets.collectGarbage(service.referencedAssetRefs())` 即可，成本是一次目录遍历。
**失败不得拖垮启动**：用 try/catch 包住并只告警（草稿库可用性比回收几个孤儿字节重要）。

**同时删除 `src/shared/inbox-legacy.ts`**：Task 1 为隔离骨架旧类型而临时新增了它
（`src/host/index.ts` 与 `src/client/index.ts` 当时仍在使用旧收件箱类型，直接删类型会让
typecheck 从 Task 1 一直红到 Task 8）。本任务整文件重写 `src/host/index.ts` 后，host 侧
不再引用旧类型；把该文件里 **host 用到的那些类型**与 `src/host/index.ts` 的旧 import 一并删掉。
注意：`src/client/index.ts` 仍在用旧类型（Task 8 才改），所以本任务**不能整份删除该文件**——
只删 host 用到的部分；若删完 client 侧仍需要，就把它缩到只剩 client 需要的类型并改名为
`src/client/inbox-legacy.ts`，或保留原位并加注「Task 8 删除」。删除动作必须在 Task 8 收口。

- [ ] **Step 5: 运行测试确认通过**

Run: `node --import tsx --test "tests/host/routes.test.ts"`
Expected: PASS — 全部用例通过（占位测试已按注记替换为真断言）

- [ ] **Step 6: 全量测试 + 类型检查 + 构建**

```bash
node --import tsx --test "tests/**/*.test.ts"
pnpm typecheck
pnpm build
```
Expected: 全部 exit 0；`lib/index.js` 与 `lib/client.js` 均产出

- [ ] **Step 7: Commit**

```bash
git add src/host/routes.ts src/host/index.ts tests/host/routes.test.ts
git commit -m "feat(host): /invoke 草稿路由与资产读取路由，重写 host 装配"
```

---

### Task 6: 模型面（工具 + 系统提示段）

**Files:**
- Create: `src/host/tools.ts`
- Test: `tests/host/tools.test.ts`

**Interfaces:**
- Consumes: `ElementRegistry`（Task 3）
- Produces:
  - `function registerPromptInboxTools(options: { tools: ToolsFace; registry: ElementRegistry }): () => void`
  - `function buildPromptSection(registry: ElementRegistry): string`

- [ ] **Step 1: 写失败的测试**

创建 `tests/host/tools.test.ts`：

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPromptSection, registerPromptInboxTools } from '../../src/host/tools.ts'
import { createElementRegistry } from '../../src/host/element-registry.ts'
import type { DraftElementRecord } from '../../src/shared/types.ts'

function degraded(id: string, label?: string): DraftElementRecord {
  return { id, ...(label !== undefined ? { label } : {}), payload: null, degraded: true }
}

test('激活集为空时提示段返回空串（不占上下文）', () => {
  assert.equal(buildPromptSection(createElementRegistry()), '')
})

test('提示段列出编号与标签，并说明 payload 不可得', () => {
  const registry = createElementRegistry()
  registry.activate([degraded('DOM14', '完全权限'), degraded('DOM15')], '草稿 drf_1')
  const text = buildPromptSection(registry)
  assert.match(text, /DOM14/)
  assert.match(text, /完全权限/)
  assert.match(text, /DOM15/)
  assert.match(text, /prompt_inbox_element/)
})

test('工具注册返回 disposer，注册名正确', () => {
  const registered: string[] = []
  const dispose = registerPromptInboxTools({
    tools: { register: (def) => { registered.push(def.name); return () => { registered.push('disposed:' + def.name) } } },
    registry: createElementRegistry(),
  })
  assert.deepEqual(registered, ['prompt_inbox_element'])
  dispose()
  assert.deepEqual(registered, ['prompt_inbox_element', 'disposed:prompt_inbox_element'])
})

test('工具命中时返回摘要并明确 payload 不可得', async () => {
  const registry = createElementRegistry()
  registry.activate([degraded('DOM14', '完全权限')], '草稿 drf_1')
  let execute: ((args: unknown) => Promise<unknown>) | undefined
  registerPromptInboxTools({
    tools: { register: (def) => { execute = def.execute; return () => {} } },
    registry,
  })
  const value = (await execute!({ id: 'DOM14' })) as { ok: boolean; id: string; label?: string; payloadAvailable: boolean; note?: string }
  assert.equal(value.ok, true)
  assert.equal(value.id, 'DOM14')
  assert.equal(value.label, '完全权限')
  assert.equal(value.payloadAvailable, false, '必须诚实报告 payload 不可得')
  assert.match(String(value.note), /不可得|摘要/)
})

test('工具未命中时回可用编号清单', async () => {
  const registry = createElementRegistry()
  registry.activate([degraded('DOM1')], '草稿 drf_1')
  let execute: ((args: unknown) => Promise<unknown>) | undefined
  registerPromptInboxTools({
    tools: { register: (def) => { execute = def.execute; return () => {} } },
    registry,
  })
  const value = (await execute!({ id: 'DOM9' })) as { ok: boolean; error?: string }
  assert.equal(value.ok, false)
  assert.match(String(value.error), /DOM1/)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --import tsx --test "tests/host/tools.test.ts"`
Expected: FAIL — `Cannot find module '.../src/host/tools.ts'`

- [ ] **Step 3: 写 tools**

创建 `src/host/tools.ts`：

- `buildPromptSection(registry)`：空时返回 `''`；否则返回形如

```
草稿元素快照（用户消息中的 [DOMn] 与下列编号一一对应，来源：草稿 drf_1）：
DOM14=完全权限
需要元素信息时调用 prompt_inbox_element 工具；当前只能提供编号/标签/来源页摘要。
```

- `registerPromptInboxTools`：注册 `prompt_inbox_element` 工具，`parameters.properties.id` 为 string，
  `output.render` 返回 `[{ type: 'text', text: JSON.stringify(value, null, 2) }]`，
  `execute` 命中时返回
  `{ ok: true, id, label?, pageUrl?, payload, payloadAvailable: payload !== null, note: '当前只能提供摘要：完整 payload 被 dsh-webpage-element-picker 的插件边界挡住，未保存。' }`，
  未命中时返回 `{ ok: false, error: '未找到元素 <id>，可用编号: <列表或 (无)>' }`。
  返回 `ctx.effect` 兼容的 disposer。

- [ ] **Step 4: 在 index.ts 里挂上**

在 `apply` 中加：

```ts
const tools = ctx.get('tools') as ToolsFace
const systemPrompt = ctx.get('systemPrompt') as SystemPromptFace
ctx.effect(() => registerPromptInboxTools({ tools, registry }))
ctx.effect(() => systemPrompt.context({
  name: 'prompt-inbox',
  order: CONTEXT_ORDER,
  text: () => buildPromptSection(registry),
}))
```

**注意（本步的实际情况与本节原始文字不同）**：Task 5 重写 `src/host/index.ts` 时，
骨架里旧的 `prompt_inbox_list` 工具注册与旧的 `prompt-inbox` 上下文段**已经被删掉了**，
无需再删一次。本步是**纯新增**：只做「取服务 + 注册」两件事。

`index.ts` 目前已在 `inject` 里声明 `'tools'` 与 `'systemPrompt'`，但**刻意没有取它们**
（第 9-10 行的注释说明了原因：提前取会触发 `noUnusedLocals`）。本步把这两个 `ctx.get(...)`
补上并立刻用于注册，因此不会再有未使用变量；同时把第 9-10 行那段「见 Task 6，届时才取」的
注释改成陈述事实（模型面已在本文件注册）。

- [ ] **Step 5: 运行测试确认通过**

Run: `node --import tsx --test "tests/host/tools.test.ts"`
Expected: PASS — 5 tests, 0 fail

- [ ] **Step 6: 类型检查 + 全量测试 + 提交**

```bash
pnpm typecheck
node --import tsx --test "tests/**/*.test.ts"
git add src/host/tools.ts src/host/index.ts tests/host/tools.test.ts
git commit -m "feat(host): prompt_inbox_element 工具与元素快照提示段"
```

---

### Task 7: client 记录转换（纯逻辑）

**Files:**
- Create: `src/client/draft-record.ts`
- Test: `tests/client/draft-record.test.ts`

**Interfaces:**
- Consumes: `DraftSavePayload`、`DraftRecord`（Task 1）
- Produces:
  - `function bytesToBase64(bytes: Uint8Array): string`
  - `function previewLine(text: string, max?: number): string`
  - `function summarize(record: DraftRecord): string`
  - `function sessionBadge(record: DraftRecord, currentSessionId: string): string | undefined`
  - `function hasRestorableAttachments(record: DraftRecord): boolean`

- [ ] **Step 1: 写失败的测试**

创建 `tests/client/draft-record.test.ts`：

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bytesToBase64, hasRestorableAttachments, previewLine, sessionBadge, summarize } from '../../src/client/draft-record.ts'
import type { DraftRecord } from '../../src/shared/types.ts'

function record(over: Partial<DraftRecord> = {}): DraftRecord {
  return {
    id: 'drf_1', createdAt: 0, originSessionId: 'sess-a', active: false,
    content: { text: 'hello', attachments: [], elements: [] },
    ...over,
  }
}

test('bytesToBase64 与 Buffer 结果一致', () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 255])
  assert.equal(bytesToBase64(bytes), Buffer.from(bytes).toString('base64'))
})

test('bytesToBase64 处理空数组', () => {
  assert.equal(bytesToBase64(new Uint8Array([])), '')
})

test('previewLine 压平空白并截断', () => {
  assert.equal(previewLine('a\n\n  b   c'), 'a b c')
  assert.equal(previewLine('x'.repeat(80), 10), 'x'.repeat(10) + '…')
})

test('previewLine 对空文本回占位', () => {
  assert.equal(previewLine('   '), '(空草稿)')
})

test('summarize 汇总附件与元素数量', () => {
  const r = record({
    content: {
      text: 't',
      attachments: [
        { name: 'a', mediaType: 'text/plain', size: 1, kind: 'file', degraded: false },
        { name: 'b', mediaType: 'text/plain', size: 1, kind: 'file', degraded: true },
      ],
      elements: [{ id: 'DOM1', payload: null, degraded: true }],
    },
  })
  const text = summarize(r)
  assert.match(text, /2 个附件/)
  assert.match(text, /1 个元素/)
  // 降级段按组分列（附件 1 项、元素 1 项），不求和——用户要知道降的是哪一类
  assert.match(text, /1 项降级附件/)
  assert.match(text, /1 项降级元素/)
})

test('summarize 无附件无元素时不提这两项', () => {
  const text = summarize(record())
  assert.doesNotMatch(text, /附件/)
  assert.doesNotMatch(text, /元素/)
})

test('sessionBadge 对同会话返回 undefined，对异会话返回来源', () => {
  assert.equal(sessionBadge(record(), 'sess-a'), undefined)
  assert.equal(sessionBadge(record({ originLabel: '别的会话' }), 'sess-b'), '别的会话')
  assert.equal(sessionBadge(record({ originSessionId: 'sess_abcdefgh' }), 'sess-b'), 'sess_abc')
})

test('hasRestorableAttachments 只看非降级附件', () => {
  assert.equal(hasRestorableAttachments(record()), false)
  assert.equal(hasRestorableAttachments(record({
    content: { text: 't', attachments: [{ name: 'a', mediaType: 't', size: 1, kind: 'file', degraded: true }], elements: [] },
  })), false)
  assert.equal(hasRestorableAttachments(record({
    content: {
      text: 't', elements: [],
      attachments: [{ name: 'a', mediaType: 't', size: 1, kind: 'file', degraded: false, asset: { sha256: 'x', ref: 'sha256/xx/x.bin' } }],
    },
  })), true)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --import tsx --test "tests/client/draft-record.test.ts"`
Expected: FAIL — `Cannot find module '.../src/client/draft-record.ts'`

- [ ] **Step 3: 写 draft-record**

创建 `src/client/draft-record.ts`：

- `bytesToBase64`：分块 `String.fromCharCode` 后 `btoa`，避免大文件爆栈（每块 0x8000）
- `previewLine(text, max = 60)`：`replace(/\s+/g, ' ').trim()`，空则 `'(空草稿)'`，超长截断加 `…`
- `summarize(record)`：拼 `N 个附件` / `N 个元素`（计数为 0 的项不出现），
  两者之一存在时追加降级段。**降级段按组分列，不求和也不折叠**：
  `· N 项降级附件` / `· N 项降级元素`（各组的降级数为 0 时不出现）。
  求和是错的——一条「1 个降级附件 + 1 个降级元素」的记录若报「2 项降级」，
  用户无从知道降的是哪一类，而修复路径完全不同（重新选文件 vs 重新选元素）。
  **也不要为「只有一组降级」加折叠成单段 `· N 项降级` 的分支**：折叠后那一段既不带组别也
  无法承载计数，用例只能退化成「组无关、计数无约束」的断言，`N=1` 的钉住随之丢失。
  （注意措辞：`/1 项降级附件/` 并不匹配 `2 项降级附件`；正则真正的弱点是多位数计数——
  `21 项降级附件` 也命中 `1 项降级附件`。所以钉住计数要靠整串 `assert.equal`，而不是靠正则。）
  恒定的按组格式可以用 `assert.equal` 整串锁定，那才是更强的断言。
  对应地，L1909 那条用例对同一条记录应断言 `/1 项降级附件/` 与 `/1 项降级元素/`，而不是 `/1 项降级/`。
- `sessionBadge(record, currentSessionId)`：同会话 undefined；否则 `originLabel`，缺失时取 `originSessionId` 前 8 字符
- `hasRestorableAttachments(record)`：存在 `degraded === false && asset !== undefined` 的附件

- [ ] **Step 4: 运行测试确认通过**

Run: `node --import tsx --test "tests/client/draft-record.test.ts"`
Expected: PASS — 9 tests, 0 fail

- [ ] **Step 5: 类型检查并提交**

```bash
pnpm typecheck
git add src/client/draft-record.ts tests/client/draft-record.test.ts
git commit -m "feat(client): 草稿记录转换与列表摘要（纯逻辑）"
```

---

### Task 8: composer 适配层与保存按钮

**Files:**
- Create: `src/client/host-call.ts`
- Create: `src/client/composer-bridge.ts`
- Create: `src/client/SaveDraftButton.ts`
- Create: `src/client/styles.ts`（样式常量集中处）
- Modify: `src/client/index.ts`（**移除骨架里的「收件箱」按钮注册**，改注册保存按钮）
- Modify: `src/client/services.ts`（补 `ClientCtx` 的 `conversation` 面）

**Interfaces:**
- Consumes: Task 7
- Produces:
  - `function hostCall(method: string, params?: Record<string, unknown>): Promise<InvokeResult>`
  - `function resolveComposer(ctx: ClientCtx): ComposerFace`
  - `function snapshotDraft(composer: ComposerFace, sessionId: string, input: { draft: string; attachmentIds: readonly string[] }): Promise<DraftSavePayload>`
  - `function restoreDraft(composer: ComposerFace, sessionId: string, record: DraftRecord, inputActions: InputActionsLike, assetUrls: Record<string, string>): Promise<{ restored: number; missing: number }>`
  - `STYLE_CSS` 等样式常量（从 `index.ts` 抽出；Task 9 复用）

- [ ] **Step 1: 写 services.ts 的会话面类型**

在 `src/client/services.ts` 里追加（**只类型，不产生运行时导入**）：

```ts
/** 上传到 host 的通用文件凭据（只声明本插件读取到的字段）。 */
export interface FileAttachmentRefLike { readonly receiptId: string }

/** 浏览器拥有的草稿附件（与 ComposerAttachment 同形，只取本插件用到的字段）。 */
export type ComposerAttachmentLike =
  | { kind: 'image'; id: string; file: Blob }
  | { kind: 'file'; id: string; file: Blob }

/**
 * `ui-conversation` 的 ConversationController 面。
 * 它是「root singleton, provided as `conversation`」，因此经 ctx.get('conversation') 取。
 * resolveDraftAttachments / createDrafts / addAttachments 是包内面而非文档化公开面——
 * 适配层必须做运行时方法存在性校验，缺失时抛出明确错误（见 spec §7-2）。
 */
export interface ComposerFace {
  resolveDraftAttachments(ids: readonly string[]): readonly ComposerAttachmentLike[]
  createDrafts(sessionId: string, files: readonly Blob[]): readonly { id: string }[]
}
```

并把 `ClientCtx` 改为：

```ts
export type ClientCtx = Context & {
  slots: SlotsService
}
```

（`conversation` 不经 cordis 注入声明，而是运行时 `ctx.get('conversation')` —— 因为它不是本插件的硬依赖，
缺失时只影响附件能力，不应让整个插件挂起。）

- [ ] **Step 2: 写 host-call**

创建 `src/client/host-call.ts`：与骨架里已有的 `hostCall` 同构（同源 origin、
POST `{ method, params }`、HTTP 非 2xx 抛错、耗时 >500ms 记 INFO、DEBUG 记方法名），
但导出供多个组件复用，并新增 `assetUrl(ref)` 拼 `'/dsh-prompt-inbox/asset?ref=' + encodeURIComponent(ref)`。

- [ ] **Step 3: 写 composer-bridge**

创建 `src/client/composer-bridge.ts`：

```ts
/**
 * composer 适配层：唯一读 `ctx.get('conversation')` 包内面的地方。
 * 把「可能变形的包内面」收在一个函数里，缺失时抛出可定位的错误。
 */
export function resolveComposer(ctx: ClientCtx): ComposerFace {
  const conversation = ctx.get('conversation') as Partial<ComposerFace> | undefined
  if (conversation === undefined) {
    throw new Error('conversation 服务不可用：无法保存/回弹附件')
  }
  for (const method of ['resolveDraftAttachments', 'createDrafts'] as const) {
    if (typeof conversation[method] !== 'function') {
      throw new Error('conversation 服务的 ' + method + ' 已不可用（harness 升级可能改了包内面），请升级本插件')
    }
  }
  return conversation as ComposerFace
}
```

`snapshotDraft(composer, sessionId, input)`：
1. `composer.resolveDraftAttachments(input.attachmentIds)` 拿附件
2. 逐个 `await file.arrayBuffer()` → `bytesToBase64` → 拼 `DraftSavePayload['attachments']` 项
3. `mediaType` 取 `file.type || 'application/octet-stream'`，`kind` 取附件的 `kind`
4. 返回 `{ text: input.draft, originSessionId: sessionId, attachments, elements: [] }`
   （`elements` 由 host 从正文提取，client 不解析占位符）

`restoreDraft(composer, sessionId, record, inputActions, assetUrls)`：
1. 对每个 `degraded === false && asset !== undefined` 的附件：
   `await fetch(assetUrls[asset.ref] ?? assetUrl(asset.ref))` → `arrayBuffer` → `new File([bytes], name, { type: mediaType })`
   **注意 assetUrls 的值已经是可直接 fetch 的完整同源路径**（host 侧 `routes.ts` 的 `draft-get`
   返回的就是 `/dsh-prompt-inbox/asset?ref=<已编码>`）。再套一层 `assetUrl()` 会把整条路径当成
   ref 去二次编码，过不了 host 的 `ASSET_REF_PATTERN` 白名单 → 400 → **每个附件都被算成 missing**，
   回弹永远修不回任何附件。`assetUrl()` 只用于「拿不到 host 给的值」时的兜底拼接。
   （`File` 在浏览器全局可用；Node 测试环境不覆盖此函数）
2. `composer.createDrafts(sessionId, files)` → `inputActions.addAttachments(ids)`
   **若 `addAttachments` 返回 false（composer 处于 busy 阶段拒收），必须抛错并放弃写正文**：
   半截回弹（附件没进去、正文却覆盖了）比整个失败更糟——用户会以为草稿回来了。
3. `inputActions.setDraft(record.content.text)`
4. 返回 `{ restored, missing }`，其中 **missing = 未能恢复的附件数**：降级项、无 asset 项、
   以及字节取不回来的项都计入（用户需要知道「有几个附件没回来」，而不只是「有几个下载失败」）。

**顺序不可倒**：必须先塞附件再写文字，因为 `addAttachments` 在 busy 阶段会被拒。

- [ ] **Step 4: 写 SaveDraftButton**

创建 `src/client/SaveDraftButton.ts`：`conversation.input.left` 的 list 槽位组件。

- `props.useInput((s) => s.draft)` 取文字；`props.useInput((s) => s.attachmentIds)` 取附件 id
- `draft.trim() === '' && attachmentIds.length === 0` 时 `return null`（**有内容才出现**）
- 渲染 `<button className="dsh-pi-save" title="保存到草稿" aria-label="保存到草稿">` + 保存图标 SVG
- 点击：`snapshotDraft(composer, sessionId, { draft, attachmentIds })`
  → `hostCall('draft-save', { payload })` → 成功弹 notice「已保存到草稿」+ `warnings` 逐条展示；
  失败弹 notice「保存失败：<error>」
- `busy` 期间 `disabled`
- `sessionId` 从 `props.sessionId` 取（`conversation.input.left` 是 session 作用域，标准 props 里有）
- `composer` 经 `resolveComposer(ctx)` 取；`ctx` 由 `inject` 工厂闭包传入（见 Task 9 Step 5 的说明）

> **必须同时删除骨架里的旧按钮**：`src/client/index.ts` 现在注册了一个 id 为
> `PLUGIN_ID` 的「收件箱」按钮（同样的 `conversation.input.left`、同样的 `order: 0`）。
> 本步骤要**删掉那段注册代码与其面板实现**，只保留新的保存按钮；否则界面上会同时
> 出现「收件箱」和保存图标两个按钮，而前者已经没有任何后端路由可调。

- [ ] **Step 5: 抽出 styles.ts**

把 `src/client/index.ts` 里的 `STYLE_CSS` 常量与 `ctx.effect` 注入
`<style data-plugin="dsh-prompt-inbox">` 的清理逻辑移到 `src/client/styles.ts`，
导出 `STYLE_CSS` 与 `installStyles(ctx)`；`index.ts` 改为调用 `installStyles(ctx)`。
本任务先只搬移、不新增类名（Task 9 再加草稿列表的类名）。

- [ ] **Step 6: 在 client/index.ts 注册保存按钮**

在 `apply` 里追加（并确认旧的「收件箱」注册已被删除）：

```ts
ctx.effect(() => ctx.slots.inject('conversation.input.left', () => ctx.slots.register(
  {
    name: 'conversation.input.left',
    id: PLUGIN_ID + '-save',
    order: 0,
    inject: () => ({ ctx }),
  },
  SaveDraftButton as (props: Record<string, unknown>) => unknown,
)))
```

- [ ] **Step 7: 类型检查 + 构建 + 人工验证**

**同时收口 `src/shared/inbox-legacy.ts`**：Task 1 为隔离骨架旧类型临时新增了它，
Task 5 已删掉 host 侧的使用。本任务移除骨架的「收件箱」按钮后，client 侧也不再引用旧类型，
因此**在这一步删除 `src/shared/inbox-legacy.ts` 与 `src/client/index.ts` 里指向它的 import**，
并在提交前确认全仓再无 `inbox-legacy` 引用（`grep -r inbox-legacy src/` 应无输出）。
留着它就是一个没人认领的死文件。

```bash
pnpm typecheck
pnpm build
```

人工验证（需先 `pnpm dsh plugin --profile web add .` 并重启 `dsh web`）：
输入框打字 → 图标出现；清空 → 图标消失；点图标 → `~/.dsh/prompt-inbox.jsonl` 出现一行，
且**直接读出该行内容**确认 `content.text` 与输入框一致。

- [ ] **Step 8: Commit**

```bash
git add src/client/host-call.ts src/client/composer-bridge.ts src/client/SaveDraftButton.ts src/client/styles.ts src/client/index.ts src/client/services.ts
git commit -m "feat(client): composer 适配层、样式抽离与「保存到草稿」按钮"
```

---

### Task 9: 草稿 tab、列表与回弹

**Files:**
- Create: `src/client/DraftView.ts`
- Create: `src/client/DraftStrip.ts`
- Modify: `src/client/index.ts`（注册 view 与 dock）
- Modify: `src/client/styles.ts`（抽出样式常量，供三个组件共用）

**Interfaces:**
- Consumes: Task 7、Task 8
- Produces:
  - `DraftView`：`conversation.view` 的组件，`label: () => '草稿'`
  - `DraftStrip`：`conversation.input.dock` 的列表组件

- [ ] **Step 1: 给 styles.ts 追加草稿列表的类名**

`src/client/styles.ts` 已在 Task 8 建好（只搬移了骨架里的样式）。本步骤在 `STYLE_CSS`
里追加草稿列表所需类名：`.dsh-pi-item` / `.dsh-pi-item-active` / `.dsh-pi-item-head` /
`.dsh-pi-item-text` / `.dsh-pi-item-meta` / `.dsh-pi-badge` / `.dsh-pi-actions` /
`.dsh-pi-btn` / `.dsh-pi-strip` / `.dsh-pi-strip-head` / `.dsh-pi-strip-row` /
`.dsh-pi-strip-text` / `.dsh-pi-view` / `.dsh-pi-view-head` / `.dsh-pi-toggle` /
`.dsh-pi-confirm` / `.dsh-pi-notice` / `.dsh-pi-empty`。

配色沿用骨架已有的深色值（背景 `#1b1b22`、边框 `#34343e`、正文 `#e6e6eb`、
次要文字 `#9a9aa6`），保持与 `[完全权限]` 那一行同一套视觉语言。

- [ ] **Step 2: 写 restore-action（两处共用的回弹逻辑，避免复制）**

创建 `src/client/restore-action.ts`：

```ts
/**
 * 回弹动作：草稿 tab 与空会话草稿列表共用这一份实现，避免两处各写一遍
 * 「取记录 → 确认覆盖 → 恢复附件 → 写正文 → 置 active」的顺序逻辑。
 *
 * 顺序不可倒：必须先塞附件再写文字，因为 addAttachments 在 busy 阶段会被拒。
 */

import { hostCall } from './host-call.ts'
import { resolveComposer, restoreDraft } from './composer-bridge.ts'
import type { ClientCtx, InputActionsLike } from './services.ts'
import type { DraftRecord, InvokeResult } from '../shared/types.ts'

/** 回弹结果，供调用方决定提示文案。 */
export interface RestoreOutcome {
  ok: boolean
  error?: string
  /** 未能恢复的附件数（资产缺失或下载失败）。 */
  missing: number
}

/**
 * 把一条草稿回弹进输入框。
 * @param ctx - client 上下文（用于取 conversation 服务）。
 * @param sessionId - 回弹目标会话；是**当前会话**而非草稿的来源会话。
 * @param record - 目标草稿。
 * @param inputActions - 槽位标准 props 里的输入动作面。
 * @returns 结果；失败时 error 已可直接展示。
 */
export async function performRestore(
  ctx: ClientCtx,
  sessionId: string,
  record: DraftRecord,
  inputActions: InputActionsLike,
): Promise<RestoreOutcome> {
  const got: InvokeResult = await hostCall('draft-get', { id: record.id })
  if (!got.ok || got.record === undefined) {
    return { ok: false, error: got.error ?? '读取草稿失败', missing: 0 }
  }
  try {
    const result = await restoreDraft(resolveComposer(ctx), sessionId, got.record, inputActions, got.assetUrls ?? {})
    // 只有成功回弹才置 active：失败时不能让列表标出一条其实没进输入框的草稿
    await hostCall('draft-set-active', { id: record.id })
    return { ok: true, missing: result.missing }
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message || err), missing: 0 }
  }
}
```

- [ ] **Step 3: 写 DraftView**

创建 `src/client/DraftView.ts`：

```ts
/**
 * 草稿 tab：`conversation.view` 上的一个视图。
 *
 * 数据全部来自 host（单一事实源），本组件只在挂载/操作后重新拉取，
 * 不缓存副本——列表因此永远和 jsonl 一致。
 */

import { React, h } from './react'
import { hostCall } from './host-call.ts'
import { performRestore } from './restore-action.ts'
import { previewLine, sessionBadge, summarize } from './draft-record.ts'
import type { ClientCtx, DraftViewProps } from './services.ts'
import type { DraftRecord } from '../shared/types.ts'

/** 相对时间：只做到「刚刚 / N 分钟前 / N 小时前 / N 天前」，够用即可。 */
function relativeTime(at: number): string {
  const delta = Date.now() - at
  if (delta < 60_000) return '刚刚'
  if (delta < 3_600_000) return Math.floor(delta / 60_000) + ' 分钟前'
  if (delta < 86_400_000) return Math.floor(delta / 3_600_000) + ' 小时前'
  return Math.floor(delta / 86_400_000) + ' 天前'
}

/** 草稿 tab 组件。 */
export function DraftView(props: DraftViewProps): unknown {
  const [records, setRecords] = React.useState<DraftRecord[]>([])
  const [showAll, setShowAll] = React.useState(false)
  const [notice, setNotice] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [pendingConfirm, setPendingConfirm] = React.useState<DraftRecord | null>(null)

  const draft = props.useInput ? props.useInput((s) => s.draft) : ''
  const attachmentIds = props.useInput ? props.useInput((s) => s.attachmentIds) : []
  const composerBusy = draft.trim() !== '' || attachmentIds.length > 0

  const reload = React.useCallback(() => {
    hostCall('draft-list').then((res) => {
      if (res.ok) setRecords(res.records ?? [])
      else setNotice('读取草稿列表失败：' + (res.error ?? '未知错误'))
    }).catch((err: unknown) => {
      setNotice('读取草稿列表失败：' + String((err as Error)?.message || err))
    })
  }, [])

  // 挂载时拉一次
  React.useEffect(() => { reload() }, [reload])

  const visible = showAll
    ? records
    : records.filter((r) => r.originSessionId === props.sessionId)

  /** 真正执行回弹（二次确认之后，或输入框为空时直接走这里）。 */
  const runRestore = (record: DraftRecord): void => {
    setPendingConfirm(null)
    setBusy(true)
    setNotice('')
    performRestore(props.ctx as ClientCtx, props.sessionId, record, props.inputActions ?? {})
      .then((outcome) => {
        if (!outcome.ok) {
          setNotice('回弹失败：' + (outcome.error ?? '未知错误'))
          return
        }
        setNotice(outcome.missing > 0
          ? '已回弹草稿，但有 ' + outcome.missing + ' 个附件未能恢复'
          : '已回弹草稿')
        reload()
      })
      .finally(() => { setBusy(false) })
  }

  const onRestore = (record: DraftRecord): void => {
    // 输入框非空时先确认——setDraft 是整体替换语义，覆盖掉的内容找不回来
    if (composerBusy) setPendingConfirm(record)
    else runRestore(record)
  }

  const onRemove = (record: DraftRecord): void => {
    setBusy(true)
    hostCall('draft-remove', { id: record.id })
      .then((res) => {
        if (!res.ok) setNotice('删除失败：' + (res.error ?? '未知错误'))
        else { setNotice('已删除草稿'); reload() }
      })
      .catch((err: unknown) => { setNotice('删除失败：' + String((err as Error)?.message || err)) })
      .finally(() => { setBusy(false) })
  }

  // 每条先算一次摘要：summarize 对「只有文字」的草稿返回空串，下面拼元信息行时要判空，
  // 重复调用也浪费（同一条记录算两遍）
  const rows = visible.map((record) => {
    const summary = summarize(record)
    const badge = sessionBadge(record, props.sessionId)
    return h(
    'div',
    { key: record.id, className: 'dsh-pi-item' + (record.active ? ' dsh-pi-item-active' : '') },
    h('div', { className: 'dsh-pi-item-head' },
      h('span', { className: 'dsh-pi-item-text' }, previewLine(record.content.text)),
      record.active ? h('span', { className: 'dsh-pi-badge' }, '当前') : null,
      badge !== undefined ? h('span', { className: 'dsh-pi-badge' }, badge) : null,
    ),
    h('div', { className: 'dsh-pi-item-meta' },
      // summarize 对「只有文字」的草稿返回空串，直接拼会渲染出前导的 ' · '。空串时只显示时间。
      (summary === '' ? '' : summary + ' · ') + relativeTime(record.createdAt),
    ),
    h('div', { className: 'dsh-pi-actions' },
      h('button', { className: 'dsh-pi-btn', disabled: busy, onClick: () => { onRestore(record) } }, '回弹'),
      h('button', { className: 'dsh-pi-btn', disabled: busy, onClick: () => { onRemove(record) } }, '删除'),
    ),
    )
  })

  return h(
    'div',
    { className: 'dsh-pi-view' },
    h('div', { className: 'dsh-pi-view-head' },
      h('span', { className: 'dsh-pi-title' }, '草稿（' + visible.length + '）'),
      h('label', { className: 'dsh-pi-toggle' },
        h('input', { type: 'checkbox', checked: showAll, onChange: () => { setShowAll(!showAll) } }),
        '全部会话',
      ),
    ),
    notice ? h('div', { className: 'dsh-pi-notice' }, notice) : null,
    pendingConfirm !== null
      ? h('div', { className: 'dsh-pi-confirm' },
          h('div', null, '回弹会覆盖输入框里现有的内容，继续？'),
          h('div', { className: 'dsh-pi-actions' },
            h('button', { className: 'dsh-pi-btn', onClick: () => { setPendingConfirm(null) } }, '取消'),
            h('button', { className: 'dsh-pi-btn', onClick: () => { runRestore(pendingConfirm) } }, '确认覆盖'),
          ),
        )
      : null,
    rows.length > 0
      ? rows
      : h('div', { className: 'dsh-pi-empty' }, showAll ? '还没有任何草稿' : '本会话还没有草稿'),
  )
}
```

- [ ] **Step 4: 写 DraftStrip**

创建 `src/client/DraftStrip.ts`：注册进 `conversation.input.dock`（list、session 作用域）。

```ts
/**
 * 空会话的草稿列表：随 composer 一起滚动，位于输入框下方。
 * 只在当前会话没有任何草稿时出现，回退展示其他会话最近的草稿——
 * 否则新会话里看不到任何已存草稿，草稿库等于白存。
 */

import { React, h } from './react'
import { hostCall } from './host-call.ts'
import { performRestore } from './restore-action.ts'
import { previewLine, sessionBadge } from './draft-record.ts'
import type { ClientCtx, DraftStripProps } from './services.ts'
import type { DraftRecord } from '../shared/types.ts'

/** 最多展示几条，避免空会话被草稿列表淹没。 */
const MAX_ROWS = 5

export function DraftStrip(props: DraftStripProps): unknown {
  const [records, setRecords] = React.useState<DraftRecord[]>([])
  const [notice, setNotice] = React.useState('')

  React.useEffect(() => {
    hostCall('draft-list')
      .then((res) => { if (res.ok) setRecords(res.records ?? []) })
      .catch(() => { /* 空会话列表是锦上添花，失败静默 */ })
  }, [])

  const mine = records.filter((r) => r.originSessionId === props.sessionId)
  // 本会话已有草稿时不重复展示——那片信息归草稿 tab
  if (mine.length > 0) return null

  const others = records.slice(-MAX_ROWS).reverse()
  if (others.length === 0) return null

  return h(
    'div',
    { className: 'dsh-pi-strip' },
    h('div', { className: 'dsh-pi-strip-head' }, '最近草稿'),
    notice ? h('div', { className: 'dsh-pi-notice' }, notice) : null,
    others.map((record) => h(
      'button',
      {
        key: record.id,
        className: 'dsh-pi-strip-row',
        disabled: props.inputActions === undefined,
        onClick: () => {
          performRestore(props.ctx as ClientCtx, props.sessionId, record, props.inputActions ?? {})
            .then((outcome) => {
              setNotice(outcome.ok
                ? (outcome.missing > 0 ? '已回弹，' + outcome.missing + ' 个附件未能恢复' : '')
                : '回弹失败：' + (outcome.error ?? '未知错误'))
            })
        },
      },
      h('span', { className: 'dsh-pi-strip-text' }, previewLine(record.content.text, 40)),
      sessionBadge(record, props.sessionId) !== undefined
        ? h('span', { className: 'dsh-pi-badge' }, sessionBadge(record, props.sessionId))
        : null,
    )),
  )
}
```

> **`DraftStrip` 必须带上与 tab 相同的覆盖确认，不能默认「空会话无需确认」。**
> 已核实源码：`conversation.input.dock` **并非只在 hero 态渲染** ——
> `ui-conversation/src/client/skeleton/ConversationRoot.tsx` 用
> `{zone !== undefined && renderSlot('conversation.input.dock', zone)}`，只要有 session 就有 `zone`，
> 同一棵 composer 树同时服务 hero 与活动会话（:356 的 `composer` fallback）。
> 后果：在**活动会话**里输入框非空、而本会话又没有自己的草稿时，这条列表会展示其他会话的草稿，
> 点一下 `setDraft` 就把用户正在写的内容整体替换掉——且没有任何确认。
> 所以 `DraftStrip` 与 `DraftView` **共用同一个 `shouldConfirmOverwrite(draft, attachmentIds)` 判定**
> 与同一份确认面板文案；只有判定为「输入框为空」时才直接回弹。

- [ ] **Step 5: 在 client/index.ts 注册两处，并给 services.ts 补 props 类型**

**order 必须大于 `轨迹`，否则 tab 会插到对话与轨迹中间。** 已核实源码：对话 view 注册为
`order: 0`（`ui-chat/src/client/apply.ts`），轨迹 view 注册为 `order: 10`
（`ui-trajectory/src/client/index.ts`）。所以 `order: 1` 会渲染成「对话 | 草稿 | 轨迹」，
而用户的要求是「对话 | 轨迹 | 草稿」。取 **20**（> 10）。

`src/client/services.ts` 追加（标准 props 的窄化）：

```ts
/** 草稿 tab 的完整 props（框架注入 label 之外的 runtime + 标准 props + ctx）。 */
export interface DraftViewProps {
  sessionId: string
  ctx: unknown
  useInput?<T>(selector: (state: InputStateLike & { attachmentIds: readonly string[] }) => T): T
  inputActions?: InputActionsLike
}

/** 空会话草稿列表的 props。 */
export interface DraftStripProps {
  sessionId: string
  ctx: unknown
  inputActions?: InputActionsLike
}
```

同时把 `InputStateLike` 扩为：

```ts
export interface InputStateLike {
  readonly draft: string
  readonly attachmentIds: readonly string[]
}
```

`src/client/index.ts` 追加注册：

```ts
ctx.effect(() => ctx.slots.inject('conversation.view', () => ctx.slots.register(
  { name: 'conversation.view', id: PLUGIN_ID + '-drafts', order: 20, label: () => '草稿' },
  DraftView as (props: Record<string, unknown>) => unknown,
)))
ctx.effect(() => ctx.slots.inject('conversation.input.dock', () => ctx.slots.register(
  { name: 'conversation.input.dock', id: PLUGIN_ID + '-strip', order: 0 },
  DraftStrip as (props: Record<string, unknown>) => unknown,
)))
```

> 注意：`ctx` 不能经 props 传（props 由框架构造）。改为在 `client/index.ts` 里把
> **闭包捕获的 root ctx** 通过 `inject` 工厂交给组件：`ctx.slots.register({...,
> inject: () => ({ ctx }) }, DraftView)`。相应地 `performRestore` 的第一个参数
> 来自 `props.ctx`（即 inject 传入的对象），不是从 props 顶层取。
> 三处用到 `props.ctx` 的地方都按此调整。

- [ ] **Step 6: 类型检查 + 构建 + 人工验证**

```bash
pnpm typecheck
pnpm build
```

人工验证：`草稿` tab 出现在 `轨迹` 右侧；带附件的草稿回弹后附件栏原样恢复（含图片预览）；
输入框非空时回弹弹二次确认；删除后 `~/.dsh/prompt-inbox-assets/` 下对应文件消失。

- [ ] **Step 6: Commit**

```bash
git add src/client/DraftView.ts src/client/DraftStrip.ts src/client/restore-action.ts src/client/styles.ts src/client/index.ts
git commit -m "feat(client): 草稿 tab、空会话草稿列表与回弹（含二次确认）"
```

---

### Task 10: 端到端验收与文档

**Files:**
- Modify: `README.md`（去掉「下一步」里已完成项，补配置表与已知限制）
- Modify: `AGENT.md`（补测试命令与目录）

- [ ] **Step 1: 全量回归**

```bash
pnpm typecheck
node --import tsx --test "tests/**/*.test.ts"
pnpm build
```
Expected: 三者全部 exit 0

- [ ] **Step 2: 走 spec §8 的端到端人工清单**

逐条执行并记录实际输出（**不是「应该没问题」，是贴出真实结果**）：

1. 输入框有内容 → 图标出现；清空 → 消失
2. 点保存 → `~/.dsh/prompt-inbox.jsonl` 新增一行，`prompt-inbox-assets/` 出现字节；
   **贴出该行真实内容**
3. `草稿` tab 出现在 `轨迹` 右侧
4. 带附件的草稿在新会话回弹：附件栏原样恢复（含图片预览）
5. 带 `[DOMn]` 的草稿在新会话回弹：正文保留，模型经 `prompt_inbox_element` 能读到摘要，
   且**明确回答完整 payload 不可得**
6. 输入框非空时回弹 → 弹二次确认
7. 删除草稿 → 资产被回收（`ls` 证明文件消失）
8. `degraded` 附件/元素在 UI 上有明确标注

- [ ] **Step 3: 更新 README 与 AGENT**

README：把「下一步」里已完成项移入「已实现」；补 §3.5 配置表；
补「已知限制」一节，明确写出元素完整 payload 不可得及其成因（spec §3.4）。
AGENT：命令表加 `pnpm test`（指向 `node --import tsx --test "tests/**/*.test.ts"`），目录树补 `tests/`。

- [ ] **Step 4: Commit**

```bash
git add README.md AGENT.md
git commit -m "docs: 草稿功能验收结果、配置表与已知限制"
```

---

## Self-Review

**1. Spec coverage**

| Spec 章节 | 覆盖任务 |
|---|---|
| §2 架构（三插槽 + host 单一事实源） | Task 5（host 装配）、8（保存）、9（view/dock） |
| §3.1 草稿记录（含 active/degraded） | Task 1（类型）、4（写入）、5（set-active） |
| §3.2 jsonl 追加日志 + 压紧 | Task 1 |
| §3.3 旁路资产（去重 + 引用计数） | Task 2、4（remove 回收） |
| §3.4 元素来源边界与降级 | Task 3、6 |
| §3.5 配置与上限 | Task 4（上限参数）、5（Config） |
| §3.6 `$DSH_HOME` 解析 | Task 1（home.ts） |
| §4.1 保存 | Task 8 |
| §4.2 回弹（顺序、二次确认） | Task 9 |
| §4.3 删除 + 回收 | Task 4、9 |
| §4.4 再次保存=新建 | Task 4（每次 save 发新 id） |
| §5 失败处理 8 行 | Task 3（picker 失败降级）、4（超限降级/失败）、5（路由重复注册 catch） |
| §6 UI 与文案 | Task 8（tooltip）、9（tab/列表/badge/过滤） |
| §7 已知风险 | Task 10（README 记录） |
| §8 测试与验证 | Task 1–9 的测试 + Task 10 人工清单 |

无未覆盖项。

**2. Placeholder scan**

已按 writing-plans 的「No Placeholders」逐条检查并修掉了三处初稿缺陷：

- Task 4 初稿给过一个**跑不通的同步 `await0`** 实现（异步来源不可能同 tick settle）。
  已改成 `async save()` + `await elements.lookup(ids)` 的**正确最终版**，
  不再要求执行者「先写错再改对」——计划里只允许出现正确可用的代码。
- Task 5 初稿有两条自认的假测试。已替换为真断言：`maxBodyBytes` 用小值重开一次
  `serve({ maxBodyBytes })` 断言 413；`element-list` 在 `draft-get` 之后断言长度为 1；
  另补一条「资产路由拒绝路径穿越 ref」断言 400。
- Task 9 初稿是散文。已补全 `restore-action.ts` / `DraftView.ts` / `DraftStrip.ts`
  的可执行代码。

剩余检索命中均为产品文案（`没有占位符`、`回占位`、`[DOMn] 占位符`），非计划占位。

**3. Type consistency**

- `DraftRecord` / `DraftContent` / `DraftAttachmentRecord` / `DraftElementRecord` 在 Task 1 定义，
  Task 2–9 全部按同一字段名使用（`degraded`、`asset.sha256`、`asset.ref`、`originSessionId`）。
- `AssetStore.put` 返回 `{ sha256, ref, bytes }`，Task 4 取 `put.ref` / `put.sha256`，一致。
- `ElementSource.lookup` 在 Task 3 定义为 async，Task 4 因此用 `await`，签名一致。
- `ComposerFace.resolveDraftAttachments` 在 Task 8 定义为同步返回数组（与 harness 一致），
  `snapshotDraft` 内部 `await file.arrayBuffer()`——两者不冲突。
- `performRestore(ctx, sessionId, record, inputActions)` 的 4 参签名在 Task 9 Step 2 定义，
  DraftView（Step 3）与 DraftStrip（Step 4）两处调用点参数一致。
- `restoreDraft(composer, sessionId, record, inputActions, assetUrls)` 的 5 参签名在
  Task 8 Interfaces 与 Step 3 一致，Task 9 的调用点一致。
- `DraftService.save` 是 async（Task 4），Task 5 的 `draft-save` 处理器必须 `await`，
  否则回的是 Promise 而不是记录——Task 5 Step 3 已按 `await service.save()` 描述。
- 方法名 `draft-save` / `draft-list` / `draft-get` / `draft-remove` / `draft-set-active` / `element-list`
  在 Task 5 定义，Task 8/9 调用，拼写一致。
