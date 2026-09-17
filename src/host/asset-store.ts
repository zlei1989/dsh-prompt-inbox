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

/**
 * 资产在根目录下的逻辑 ref：`sha256/<前2位>/<sha256>.bin`。
 *
 * 分隔符固定为 `/`，**不使用 `path.join`**：这个字符串会被持久化进
 * `prompt-inbox.jsonl` 的 `asset.ref`，随后又要和现场重算的 `shardRef(...)`
 * 比对（`has` / `read` / `collectGarbage`）。若随平台变成 `\`，同一份
 * `$DSH_HOME` 换到 POSIX 上读取时 ref 就对不上，`has()` 静默返回 false，
 * 全部附件降级——失败无声，正是本设计最不能接受的一种。
 *
 * 它只是逻辑标识，落盘前一律经 {@link refToPath} 转成当前平台的路径。
 */
export function shardRef(sha256: string): string {
  return 'sha256/' + sha256.slice(0, 2) + '/' + sha256 + '.bin'
}

/**
 * 把逻辑 ref 转成当前平台的绝对路径。
 *
 * ref 恒定以 `/` 分隔（见 {@link shardRef}），所以在这里才做分隔符转换：
 * 逻辑标识与文件系统路径的边界只此一处。
 *
 * @param root - 资产存储根目录。
 * @param ref - {@link shardRef} 产出的逻辑 ref。
 */
export function refToPath(root: string, ref: string): string {
  return join(root, ...ref.split('/'))
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

  return {
    put(bytes: Uint8Array): { sha256: string; ref: string; bytes: number } {
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      const ref = shardRef(sha256)
      const target = refToPath(root, ref)
      if (!existsSync(target)) {
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, bytes)
      }
      return { sha256, ref, bytes: bytes.byteLength }
    },

    read(ref: string): Uint8Array {
      const target = refToPath(root, ref)
      if (!existsSync(target)) throw new Error('资产不存在: ' + ref)
      return new Uint8Array(readFileSync(target))
    },

    has(ref: string): boolean {
      return existsSync(refToPath(root, ref))
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
