/**
 * 中心侧配置（环境变量；无默认密钥，管理接口未配 token 则整体禁用）。
 */
import { isAbsolute, resolve } from 'node:path'
import { repoRoot } from './paths.ts'

export interface GenuineConfig {
  port: number
  host: string
  /** sqlite 文件路径（:memory: 仅测试用） */
  dbPath: string
  /** 管理接口 bearer token；未设置则 /admin/* 全部 503（宁可不开放，不可裸奔） */
  adminToken: string | null
  /** 日志级别 */
  logLevel: 'debug' | 'info' | 'warn' | 'error'
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GenuineConfig {
  const level = (env['GENUINE_LOG_LEVEL'] ?? 'info') as GenuineConfig['logLevel']
  return {
    port: Number(env['GENUINE_PORT'] ?? env['PORT'] ?? 8787),
    host: env['GENUINE_HOST'] ?? env['HOST'] ?? '127.0.0.1',
    dbPath: resolveDbPath(env['GENUINE_DB_PATH'] ?? 'data/genuine.db'),
    adminToken: env['GENUINE_ADMIN_TOKEN'] ?? null,
    logLevel: ['debug', 'info', 'warn', 'error'].includes(level) ? level : 'info',
  }
}

/**
 * sqlite 路径锚定到仓库根，不用 cwd 相对：
 * - `:memory:` 是 sqlite 的特殊值（db.ts 靠它跳过 mkdirSync），必须原样透传
 * - 绝对路径原样透传
 * - 相对路径按 `repoRoot()` 解析——否则 `pnpm --filter` 下 cwd=apps/server，
 *   会落到 `apps/server/data/` 新建空库，看着像根库里的授权数据全丢了
 */
function resolveDbPath(raw: string): string {
  if (raw === ':memory:' || isAbsolute(raw)) return raw
  return resolve(repoRoot(), raw)
}
