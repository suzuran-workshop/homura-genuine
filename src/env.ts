/**
 * 中心侧配置（环境变量；无默认密钥，管理接口未配 token 则整体禁用）。
 */
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
    dbPath: env['GENUINE_DB_PATH'] ?? './data/genuine.db',
    adminToken: env['GENUINE_ADMIN_TOKEN'] ?? null,
    logLevel: ['debug', 'info', 'warn', 'error'].includes(level) ? level : 'info',
  }
}
