/**
 * 仓库根锚定。
 *
 * monorepo 化后 `process.cwd()` 不再等于仓库根：根脚本用 `pnpm --filter @homura-genuine/server`
 * 调起时 cwd 是 `apps/server`。所有「相对仓库根」的路径（sqlite 库文件、web 构建产物、对端契约）
 * 都必须显式锚定，否则会在 `apps/server/data/` 新建空库——表现为「授权数据全丢了」。
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

let cached: string | undefined

/**
 * 最近的、含 `pnpm-workspace.yaml` 的祖先目录，即仓库根。
 *   dev  (tsx)  : apps/server/src/paths.ts  向上到 <root>
 *   prod (node) : apps/server/src/paths.ts  向上到 <root>（本服务无构建步骤，prod 也直跑 TS）
 * 以裸目录部署（无 workspace 标记）时兜底 `process.cwd()`，行为与 monorepo 化之前一致。
 */
export function repoRoot(): string {
  if (cached !== undefined) return cached
  let dir = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return (cached = dir)
    const parent = dirname(dir)
    if (parent === dir) return (cached = process.cwd())
    dir = parent
  }
}
