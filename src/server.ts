/**
 * 入口：监听 PORT/HOST。中心服务独立部署（不在 qw-pages 网关后），故健康检查用 /healthz。
 *
 * 启动时会打印当前签名公钥与 keyId —— 运营需要把它配到 App 侧
 * （homura 的 GENUINE_PUBLIC_KEY / GENUINE_KEY_ID，经 config/homura.config.env 投递）。
 */
import { serve } from '@hono/node-server'
import { buildApp } from './app.js'
import { GenuineDb } from './db.js'
import { loadConfig } from './env.js'

const config = loadConfig()
const db = new GenuineDb(config.dbPath)
const { app, service } = buildApp({ db, adminToken: config.adminToken })

const key = service.activeKey()
if (key) {
  console.log(`[genuine] 签名密钥 keyId=${key.keyId}`)
  console.log(`[genuine] 公钥（配到 App 侧 GENUINE_PUBLIC_KEY）:\n${key.publicPem.trim()}`)
}
if (!config.adminToken) {
  console.warn('[genuine] 未配置 GENUINE_ADMIN_TOKEN → /admin/* 全部返回 503（无法签发或调整许可）')
}

const ac = new AbortController()
const shutdown = () => {
  console.log('[genuine] shutting down')
  ac.abort()
  db.close()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

const server = await serve({ fetch: app.fetch, port: config.port, hostname: config.host })
const addr = server.address()
console.log(
  `[genuine] listening http://${config.host}:${config.port} (db=${config.dbPath}, bound=${typeof addr === 'object' && addr ? `${addr.address}:${addr.port}` : 'unknown'})`,
)
