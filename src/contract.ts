/**
 * homura ↔ homura-genuine 的**唯一契约事实源**。
 *
 * ⚠ 本文件在两个仓库各存一份，必须逐字一致：
 *   - 中心侧：homura-genuine/src/contract.ts（本文件）
 *   - 消费侧：homura/packages/license/src/contract.ts
 *   `src/contract-parity.test.ts` 会逐字比对（对端仓库不在时跳过）。
 *   改这里 = 改契约：同步两侧、跑 parity 测试、在两侧 DECISIONS/spec 留痕。
 *
 * ⚠ 只允许依赖 Node 内置：本文件会被 App 侧打进 bundle，引第三方就是给所有派生 App 加依赖。
 */
import { createHash, createPublicKey, verify } from 'node:crypto'

export const GENUINE_API_VERSION = 'v1'

/**
 * 授权状态。
 * - `active`   正常
 * - `grace`    心跳失联但在宽限期内（消费侧本地推进，中心不下发此态）
 * - `expired`  已过 expiresAt（中心下发，消费侧也会本地判定，不等心跳）
 * - `suspended` 中心手动停服
 * - `unknown`  仅消费侧：未注册 / 验签失败 / 失联且宽限期满
 */
export type LicenseStatus = 'unknown' | 'active' | 'grace' | 'suspended' | 'expired'

/**
 * 到期或停服后的处置强度（中心按许可证设置，可随时调整；消费侧据此决定拦多少）。
 * 无论哪一档，只要 status 不是 active，消费侧都要**每次使用强提醒**（无差别对所有用户）。
 */
export type Enforcement =
  | 'none' // 只记录，功能全开、不提醒（观察期用）
  | 'notice' // 功能全开，但每次响应带强提醒
  | 'core' // 禁核心功能（App 用 corePaths 声明哪些算核心），其余放行 + 强提醒
  | 'all' // 全站停服（豁免路径除外）+ 强提醒

/** 签名保护的授权载荷：一次心跳/注册下发的全部授权事实 */
export interface LicenseEntitlement {
  licenseId: string
  productId: string
  appId: string
  /**
   * 绑定的实例标识。签名里带上它，才能防止把 A 实例的授权响应重放给 B 实例
   * （消费侧必须比对自己注册时用的 instanceKey）。
   */
  instanceKey: string
  status: LicenseStatus
  /** ISO-8601；null = 永不过期。中心可随时调整，下一次心跳即生效 */
  expiresAt: string | null
  /** 到期/停服时的处置强度 */
  enforcement: Enforcement
  /** 授权的功能范围（App 用 requireFeature('x') 逐点校验；空数组 = 只允许无标记的功能） */
  features: string[]
  /** 强提醒文案（每次使用都要展示给所有用户）；缺省由中心按到期/停服自动生成 */
  notice: string | null
  /** 签发时间 ISO-8601 */
  issuedAt: string
  /** 中心当前时间 ISO-8601（消费侧可据此校正本地时钟偏差，避免用户改系统时间绕过到期） */
  serverTime: string
  /** 心跳间隔（秒） */
  heartbeatIntervalSec: number
  /** 失联宽限期（秒） */
  graceSec: number
}

/** 带签名的授权：App 侧用中心公钥验签后才采信 */
export interface SignedEntitlement {
  entitlement: LicenseEntitlement
  /** Ed25519 签名，base64url；签名对象是 canonicalize(entitlement) */
  signature: string
  /** 签名公钥标识（sha256(publicPem) 前 16 位 hex），支持轮换 */
  keyId: string
}

export interface RegisterRequest {
  productId: string
  appId: string
  instanceKey: string
  licenseKey?: string
  version?: string
  fingerprint?: Record<string, string>
}

export interface RegisterResponse {
  licenseId: string
  status: LicenseStatus
  /** server 下发的心跳间隔（秒） */
  heartbeatIntervalSec: number
  /** 网络失联宽限期（秒） */
  graceSec: number
  issuedAt: string
  /** 签名授权（消费侧必须验签后才采信 status/features/expiresAt） */
  license: SignedEntitlement
}

export interface HeartbeatRequest {
  licenseId: string
  instanceKey: string
  metrics?: {
    activeUsers?: number
    reqPerMin?: number
  }
}

export interface HeartbeatResponse {
  status: LicenseStatus
  heartbeatIntervalSec: number
  serverTime: string
  /** 运营通知（如停服原因、联系方式）；与 entitlement.notice 同源 */
  notice?: string
  /** 签名授权 */
  license: SignedEntitlement
}

/** 公钥分发（App 可选择启动时拉取并固定，或直接内嵌公钥） */
export interface KeyInfo {
  keyId: string
  /** Ed25519 公钥 PEM（SPKI） */
  publicKey: string
  retired: boolean
}

/** 契约端点路径（相对 server base URL） */
export const GENUINE_ENDPOINTS = {
  register: `/${GENUINE_API_VERSION}/register`,
  heartbeat: `/${GENUINE_API_VERSION}/heartbeat`,
  keys: `/${GENUINE_API_VERSION}/keys`,
} as const

/** 契约里的错误码（消费侧可据此区分「授权问题」与「网络问题」） */
export const GENUINE_ERROR_CODES = {
  licenseNotFound: 'license_not_found',
  instanceMismatch: 'instance_mismatch',
  productNotFound: 'product_not_found',
  selfRegisterDisabled: 'self_register_disabled',
  badRequest: 'bad_request',
  unauthorized: 'unauthorized',
} as const

export type GenuineErrorCode = (typeof GENUINE_ERROR_CODES)[keyof typeof GENUINE_ERROR_CODES]

export interface GenuineErrorBody {
  error: GenuineErrorCode | string
  message: string
}

/**
 * canonical JSON：签名必须对**确定性序列化**生效，否则同一授权在不同实现下签出不同字节。
 * 规则：对象键按 Unicode 升序、跳过 undefined 值、数组保序、无多余空白。
 * 两个仓库共用本实现（逐字同步），不得各自另写一份。
 */
export function canonicalize(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`
  }
  const s = JSON.stringify(value)
  return s === undefined ? 'null' : s
}

// ─────────────── 验签（安全边界，两侧必须逐字一致）───────────────
//
// 为什么非对称：授权若用对称密钥（如 homura session 的 HS256），App 产物里就得带同一把密钥，
// 而产物会分发到别人的部署环境 —— 拿到产物即可自签任意授权（改到期日、加功能范围）。
// 故中心持私钥签发，App 只嵌公钥验证。选 Ed25519 而非 RS256：node:crypto 原生支持、
// 签名固定 64B、没有填充/哈希算法协商面（算法混淆类攻击面为零）。
//
// 签发侧（generateSigningKey / signEntitlement）只在中心，故不在本文件里；
// 验签侧两侧都要用，所以放这里并纳入 parity 比对。

/** keyId = sha256(公钥 PEM) 前 16 位 hex（稳定、可写日志、不含密钥材料） */
export function keyIdOf(publicKeyPem: string): string {
  return createHash('sha256').update(publicKeyPem).digest('hex').slice(0, 16)
}

export type VerifyResult = { ok: true } | { ok: false; reason: string }

/**
 * 验证签名授权。失败原因区分三类，消费侧据此决定处置：
 * - keyId 不匹配 → 中心换过密钥，本地公钥过期（应更新配置，不是被攻击）
 * - 签名校验失败 → 响应被篡改或用错密钥签发（按 tamper 处置）
 * - 验签异常 → 公钥格式错误等本地配置问题
 */
export function verifyEntitlement(signed: SignedEntitlement, publicKeyPem: string): VerifyResult {
  const expectedKeyId = keyIdOf(publicKeyPem)
  if (signed.keyId !== expectedKeyId) {
    return {
      ok: false,
      reason: `keyId 不匹配（响应 ${signed.keyId}，本地公钥 ${expectedKeyId}）：中心可能已轮换密钥`,
    }
  }
  try {
    const data = Buffer.from(canonicalize(signed.entitlement), 'utf8')
    const ok = verify(
      null,
      data,
      createPublicKey(publicKeyPem),
      Buffer.from(signed.signature, 'base64url'),
    )
    return ok ? { ok: true } : { ok: false, reason: '签名校验失败：响应被篡改或签发密钥不符' }
  } catch (err) {
    return { ok: false, reason: `验签异常：${(err as Error).message}` }
  }
}

/**
 * 消费侧判定授权是否仍然有效（不依赖中心在线）。
 * 用 serverTime 与本地时间的偏差校正后再比 expiresAt，避免改系统时间绕过到期。
 */
export function isEntitlementExpired(
  entitlement: LicenseEntitlement,
  now: number = Date.now(),
  serverTimeSkewMs: number = 0,
): boolean {
  if (entitlement.expiresAt === null) return false
  const expiresMs = Date.parse(entitlement.expiresAt)
  if (Number.isNaN(expiresMs)) return false
  return now + serverTimeSkewMs >= expiresMs
}
