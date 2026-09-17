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
