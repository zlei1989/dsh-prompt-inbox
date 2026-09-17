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
 * 无效行（坏 JSON、未知 op、record 为 null、缺 id/content）跳过；delete 产生墓碑。
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
    // 这里的校验必须是全量的运行时校验：日志可能被外部编辑过，一行 null 或残缺的
    // record 若被放进来，会让 load() 乃至 compact() 整体抛错，草稿库就再也无法自愈。
    // （先判 op 再取 record，既是为了收窄联合类型，也避免读到 delete 行上的字段。）
    if (line.op === 'upsert') {
      const record = line.record
      if (
        typeof record === 'object' &&
        record !== null &&
        typeof record.id === 'string' &&
        typeof record.content === 'object' &&
        record.content !== null
      ) {
        state.set(record.id, record)
        continue
      }
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
  // maxRecords 只作为接口占位保留：行数阈值由调用方用 recordCount() 自行判断，
  // store 不读它（读了不用的局部变量会触发 noUnusedLocals）。

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
