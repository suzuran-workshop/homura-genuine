/**
 * HTTP 装配：契约端点（公开）+ 管理端点（bearer token）+ 公钥分发。
 *
 * 契约端点严格对应 ../homura/packages/license 的 GENUINE_ENDPOINTS 与请求/响应类型；
 * 管理端点是中心自己的，不属于契约，App 侧永远不该调。
 */
import { timingSafeEqual } from 'node:crypto'
import { Hono, type Context } from 'hono'
import {
  GENUINE_ENDPOINTS,
  GENUINE_ERROR_CODES,
  type GenuineErrorBody,
  type KeyInfo,
} from '@homura-genuine/contract/contract'
import { GenuineDb } from './db.ts'
import { LicenseService, type ServiceResult } from './service.ts'
import { createStaticMiddleware } from './static.ts'

export interface BuildAppOptions {
  /** 缺省用内存库（测试）；生产由 server.ts 传文件库 */
  db?: GenuineDb
  /** 管理接口 bearer token；null/undefined 则 /admin/* 全部 503 */
  adminToken?: string | null
  /**
   * web 管理台构建产物目录（apps/web/dist）。缺省则**完全不挂静态托管**，
   * 未匹配路径一律走 JSON notFound——保证现有 app.test.ts 的「未知路径 404 JSON」零回归。
   * 生产由 server.ts 传入。
   */
  webRoot?: string
}

export interface BuiltApp {
  app: Hono
  service: LicenseService
  db: GenuineDb
}

export function buildApp(opts: BuildAppOptions = {}): BuiltApp {
  const db = opts.db ?? new GenuineDb(':memory:')
  const service = new LicenseService(db)
  const adminToken = opts.adminToken ?? null
  const app = new Hono()

  const send = <T>(c: Context, result: ServiceResult<T>) => {
    if (result.ok) return c.json(result.value)
    const body: GenuineErrorBody = { error: result.error, message: result.message }
    return c.json(body, result.status as 400)
  }

  // ── 健康检查（本服务独立部署，不在 qw-pages 网关后，用 /healthz 无冲突）──
  app.get('/healthz', (c) => c.json({ status: 'ok', service: 'homura-genuine' }))

  // ── 公钥分发：App 可选择启动时拉取，或直接把公钥内嵌进配置 ──
  app.get(GENUINE_ENDPOINTS.keys, (c) => {
    const keys: KeyInfo[] = db.listSigningKeys().map((k) => ({
      keyId: k.keyId,
      publicKey: k.publicPem,
      retired: k.retiredAt !== null,
    }))
    return c.json({ keys })
  })

  // ── 契约端点 ──
  app.post(GENUINE_ENDPOINTS.register, async (c) => {
    const req = await c.req.json().catch(() => null)
    if (!req || typeof req !== 'object') {
      return c.json(
        {
          error: GENUINE_ERROR_CODES.badRequest,
          message: '请求体必须是 JSON 对象',
        } satisfies GenuineErrorBody,
        400,
      )
    }
    return send(c, service.register(req as never))
  })

  app.post(GENUINE_ENDPOINTS.heartbeat, async (c) => {
    const req = await c.req.json().catch(() => null)
    if (!req || typeof req !== 'object') {
      return c.json(
        {
          error: GENUINE_ERROR_CODES.badRequest,
          message: '请求体必须是 JSON 对象',
        } satisfies GenuineErrorBody,
        400,
      )
    }
    return send(c, service.heartbeat(req as never))
  })

  // ── 管理端点（中心运营用）──
  const admin = new Hono()

  admin.use('*', async (c, next) => {
    if (!adminToken) {
      return c.json(
        {
          error: GENUINE_ERROR_CODES.unauthorized,
          message: '未配置 GENUINE_ADMIN_TOKEN，管理接口已整体禁用（不允许无鉴权管理授权中心）',
        } satisfies GenuineErrorBody,
        503,
      )
    }
    const header = c.req.header('authorization') ?? ''
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
    const a = Buffer.from(token)
    const b = Buffer.from(adminToken)
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return c.json(
        {
          error: GENUINE_ERROR_CODES.unauthorized,
          message: 'bearer token 无效',
        } satisfies GenuineErrorBody,
        401,
      )
    }
    await next()
  })

  admin.get('/products', (c) =>
    c.json({ products: db.listProducts().map((r) => service.describeProduct(r)) }),
  )

  admin.put('/products/:id', async (c) => {
    const id = c.req.param('id')
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    const product = db.upsertProduct({
      id,
      name: typeof body['name'] === 'string' ? body['name'] : id,
      defaultFeatures: Array.isArray(body['defaultFeatures'])
        ? (body['defaultFeatures'] as string[])
        : [],
      defaultEnforcement: asEnforcement(body['defaultEnforcement']),
      defaultTtlDays: typeof body['defaultTtlDays'] === 'number' ? body['defaultTtlDays'] : null,
      allowSelfRegister: body['allowSelfRegister'] === true,
    })
    return c.json({ product: service.describeProduct(product) })
  })

  admin.get('/licenses', (c) => {
    const productId = c.req.query('productId')
    const appId = c.req.query('appId')
    const rows = db.listLicenses({
      productId: productId || undefined,
      appId: appId || undefined,
    })
    return c.json({ licenses: rows.map((r) => service.describe(r)) })
  })

  admin.post('/licenses', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    if (typeof body['productId'] !== 'string' || typeof body['appId'] !== 'string') {
      return c.json(
        {
          error: GENUINE_ERROR_CODES.badRequest,
          message: 'productId 与 appId 必填',
        } satisfies GenuineErrorBody,
        400,
      )
    }
    const result = service.issueLicense({
      productId: body['productId'],
      appId: body['appId'],
      licenseKey: typeof body['licenseKey'] === 'string' ? body['licenseKey'] : null,
      expiresAt: body['expiresAt'] === null ? null : parseExpiry(body['expiresAt']),
      expiresInDays: typeof body['expiresInDays'] === 'number' ? body['expiresInDays'] : undefined,
      enforcement:
        body['enforcement'] === undefined ? undefined : asEnforcement(body['enforcement']),
      features: Array.isArray(body['features']) ? (body['features'] as string[]) : undefined,
      notice: typeof body['notice'] === 'string' ? body['notice'] : null,
      // 心跳与宽限可按许可调整：端到端演练需要秒级心跳，生产用分钟级
      heartbeatIntervalSec:
        typeof body['heartbeatIntervalSec'] === 'number' ? body['heartbeatIntervalSec'] : undefined,
      graceSec: typeof body['graceSec'] === 'number' ? body['graceSec'] : undefined,
    })
    if (!result.ok) return send(c, result)
    return c.json({ license: service.describe(result.value) }, 201)
  })

  admin.get('/licenses/:id', (c) => {
    const row = db.getLicense(c.req.param('id'))
    if (!row) {
      return c.json(
        {
          error: GENUINE_ERROR_CODES.licenseNotFound,
          message: c.req.param('id'),
        } satisfies GenuineErrorBody,
        404,
      )
    }
    return c.json({ license: service.describe(row) })
  })

  /** 期限与授权范围随时可调：下一次心跳即生效（消费侧也会本地按 expiresAt 判定） */
  admin.patch('/licenses/:id', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    const result = service.adjustLicense(c.req.param('id'), {
      expiresAt:
        body['expiresAt'] === null
          ? null
          : body['expiresAt'] === undefined
            ? undefined
            : (parseExpiry(body['expiresAt']) ?? undefined),
      expiresInDays: typeof body['expiresInDays'] === 'number' ? body['expiresInDays'] : undefined,
      enforcement:
        body['enforcement'] === undefined ? undefined : asEnforcement(body['enforcement']),
      features: Array.isArray(body['features']) ? (body['features'] as string[]) : undefined,
      notice:
        typeof body['notice'] === 'string'
          ? body['notice']
          : body['notice'] === null
            ? null
            : undefined,
      status: asManualStatus(body['status']),
      heartbeatIntervalSec:
        typeof body['heartbeatIntervalSec'] === 'number' ? body['heartbeatIntervalSec'] : undefined,
      graceSec: typeof body['graceSec'] === 'number' ? body['graceSec'] : undefined,
    })
    if (!result.ok) return send(c, result)
    return c.json({ license: service.describe(result.value) })
  })

  admin.get('/keys', (c) =>
    c.json({
      keys: db.listSigningKeys().map((k) => ({
        keyId: k.keyId,
        publicKey: k.publicPem,
        createdAt: new Date(k.createdAt).toISOString(),
        retired: k.retiredAt !== null,
      })),
    }),
  )

  /** 轮换：旧钥退休（历史签名仍可验），新钥成为签发用；App 侧需更新配置的公钥 */
  admin.post('/keys/rotate', (c) => {
    const old = db.getActiveSigningKey()
    if (old) db.retireSigningKey(old.keyId)
    const created = service.ensureSigningKey()
    return c.json({ keyId: created.keyId, publicKey: created.publicPem })
  })

  app.route('/admin', admin)

  // ── web 管理台同源托管（可选）──
  // 注册在所有 API 路由之后：路由 handler 先匹配先 finalize，本中间件只接到未匹配路径。
  // 内部再豁免 /healthz、/v1/*、/admin/*，让 API 的未匹配路径继续走 JSON notFound。
  // webRoot 缺省时完全不挂，未匹配路径一律 JSON notFound（保住现有 404 测试）。
  if (opts.webRoot) app.use('*', createStaticMiddleware(opts.webRoot))

  app.notFound((c) =>
    c.json(
      { error: 'not_found', message: `无此端点：${c.req.path}` } satisfies GenuineErrorBody,
      404,
    ),
  )
  app.onError((err, c) => {
    console.error('[genuine] unhandled', err)
    return c.json({ error: 'internal_error', message: err.message } satisfies GenuineErrorBody, 500)
  })

  return { app, service, db }
}

function asEnforcement(v: unknown): 'none' | 'notice' | 'core' | 'all' {
  return v === 'none' || v === 'notice' || v === 'core' ? v : 'all'
}

function asManualStatus(v: unknown): 'active' | 'suspended' | 'revoked' | undefined {
  return v === 'active' || v === 'suspended' || v === 'revoked' ? v : undefined
}

/** 接受 ms epoch 数字或 ISO 字符串 */
function parseExpiry(v: unknown): number | null | undefined {
  if (typeof v === 'number') return v
  if (typeof v === 'string') {
    const t = Date.parse(v)
    return Number.isNaN(t) ? undefined : t
  }
  return undefined
}
