/**
 * 授权业务：有效状态计算、到期与功能范围、签发。
 *
 * 有效状态 = 手动状态叠加到期：
 *   revoked / suspended（手动）→ 'suspended'
 *   expiresAt 已过            → 'expired'
 *   否则                       → 'active'
 * 中心只下发这三种；'grace' 与 'unknown' 是消费侧本地状态（失联宽限 / 未注册 / 验签失败）。
 */
import { randomUUID } from 'node:crypto'
import {
  GENUINE_ERROR_CODES,
  type Enforcement,
  type HeartbeatRequest,
  type HeartbeatResponse,
  type LicenseEntitlement,
  type LicenseStatus,
  type RegisterRequest,
  type RegisterResponse,
  type SignedEntitlement,
} from '@homura-genuine/contract/contract'
import type { AdminProduct } from '@homura-genuine/contract/admin'
import type { GenuineDb, LicenseRow, ProductRow } from './db.ts'
import { generateSigningKey, signEntitlement } from './sign.ts'

export type ServiceResult<T> =
  { ok: true; value: T } | { ok: false; status: number; error: string; message: string }

const fail = (
  status: number,
  error: string,
  message: string,
): { ok: false; status: number; error: string; message: string } => ({
  ok: false,
  status,
  error,
  message,
})

export interface IssueLicenseInput {
  productId: string
  appId: string
  /** 与 expiresInDays 二选一；都不给则用 product 的默认 TTL（可能为永不过期） */
  expiresAt?: number | null
  expiresInDays?: number
  licenseKey?: string | null
  enforcement?: Enforcement
  features?: string[]
  notice?: string | null
  heartbeatIntervalSec?: number
  graceSec?: number
}

export class LicenseService {
  private readonly db: GenuineDb

  constructor(db: GenuineDb) {
    this.db = db
    this.ensureSigningKey()
  }

  /** 首次启动自动生成签名密钥（零配置可用）；公钥与 keyId 会打进日志供运营配置到 App 侧 */
  ensureSigningKey(): { keyId: string; publicPem: string; created: boolean } {
    const existing = this.db.getActiveSigningKey()
    if (existing) return { keyId: existing.keyId, publicPem: existing.publicPem, created: false }
    const key = generateSigningKey()
    this.db.addSigningKey({
      keyId: key.keyId,
      publicPem: key.publicKey,
      privatePem: key.privateKey,
    })
    return { keyId: key.keyId, publicPem: key.publicKey, created: true }
  }

  /** 当前签发用公钥（运营需要把它配到 App 侧的 GENUINE_PUBLIC_KEY） */
  activeKey(): { keyId: string; publicPem: string } | null {
    const key = this.db.getActiveSigningKey()
    return key ? { keyId: key.keyId, publicPem: key.publicPem } : null
  }

  private signingKey(): { keyId: string; privatePem: string } {
    const key = this.db.getActiveSigningKey()
    if (!key) throw new Error('没有可用的签名密钥（signing_keys 表为空）')
    return { keyId: key.keyId, privatePem: key.privatePem }
  }

  // ── 状态与文案 ──

  /** 有效状态（手动状态优先于到期） */
  effectiveStatus(row: LicenseRow, now: number = Date.now()): LicenseStatus {
    if (row.status === 'suspended' || row.status === 'revoked') return 'suspended'
    if (row.expiresAt !== null && now >= row.expiresAt) return 'expired'
    return 'active'
  }

  /**
   * 强提醒文案：中心显式设置优先，否则按状态自动生成。
   * 只要 status 不是 active 就一定有文案——「每次使用强提醒、无差别提示所有用户」是硬要求。
   * active 时**只透传中心显式写的文案**（到期前预警、运营通知），不自动生成。
   */
  noticeFor(row: LicenseRow, status: LicenseStatus, now: number = Date.now()): string | null {
    const explicit = row.notice && row.notice.trim() !== '' ? row.notice : null
    if (status === 'active') return explicit
    if (explicit) return explicit
    if (status === 'expired') {
      const when =
        row.expiresAt !== null ? new Date(row.expiresAt).toISOString().slice(0, 10) : '未知日期'
      return `本应用的授权已于 ${when} 到期，部分或全部功能已受限。请联系供应方续期。`
    }
    return '本应用已被供应方停用，请联系供应方了解详情。'
  }

  parseFeatures(row: LicenseRow): string[] {
    try {
      const parsed: unknown = JSON.parse(row.features)
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
    } catch {
      return []
    }
  }

  entitlementFor(row: LicenseRow, now: number = Date.now()): LicenseEntitlement {
    const status = this.effectiveStatus(row, now)
    return {
      licenseId: row.licenseId,
      productId: row.productId,
      appId: row.appId,
      instanceKey: row.instanceKey ?? '',
      status,
      expiresAt: row.expiresAt === null ? null : new Date(row.expiresAt).toISOString(),
      enforcement: status === 'active' ? 'none' : row.enforcement,
      features: this.parseFeatures(row),
      notice: this.noticeFor(row, status, now),
      issuedAt: new Date(now).toISOString(),
      serverTime: new Date(now).toISOString(),
      heartbeatIntervalSec: row.heartbeatIntervalSec,
      graceSec: row.graceSec,
    }
  }

  signFor(row: LicenseRow, now: number = Date.now()): SignedEntitlement {
    const key = this.signingKey()
    return signEntitlement(this.entitlementFor(row, now), key.privatePem, key.keyId)
  }

  // ── 契约端点 ──

  register(req: RegisterRequest, now: number = Date.now()): ServiceResult<RegisterResponse> {
    if (!req.productId || !req.appId || !req.instanceKey) {
      return fail(400, GENUINE_ERROR_CODES.badRequest, 'productId / appId / instanceKey 均为必填')
    }

    // 查找顺序：licenseKey 精确命中 → (product, app, instanceKey) 已绑定实例。
    // ⚠ 语义要点：两条都没命中时，只有产品开了 allowSelfRegister 才会**新签一张**——
    //   这意味着自助注册产品**不做实例管控**（每个 instanceKey 各得一张许可）。
    //   需要"一份授权只能跑一个实例"就别开自助注册，改由中心预签发 + licenseKey 分发；
    //   那样换实例复用同一把 key 会撞 instance_mismatch（403），即盗用信号。
    let row = this.db.findLicenseForRegister(
      req.productId,
      req.appId,
      req.instanceKey,
      req.licenseKey,
    )

    if (!row) {
      const product = this.db.getProduct(req.productId)
      if (!product) {
        return fail(404, GENUINE_ERROR_CODES.productNotFound, `产品不存在：${req.productId}`)
      }
      if (!product.allowSelfRegister) {
        return fail(
          403,
          GENUINE_ERROR_CODES.selfRegisterDisabled,
          `产品 ${req.productId} 未开启自助注册：请先由中心签发许可证（POST /admin/licenses）`,
        )
      }
      row = this.db.createLicense({
        licenseId: randomUUID(),
        productId: product.id,
        appId: req.appId,
        licenseKey: req.licenseKey ?? null,
        expiresAt: ttlExpiry(product, now),
        enforcement: product.defaultEnforcement,
        features: safeJsonArray(product.defaultFeatures),
        heartbeatIntervalSec: 300,
        graceSec: 86400,
      })
      this.db.bindInstance(row.licenseId, req.instanceKey)
      row = this.db.getLicense(row.licenseId) ?? row
    }

    // 实例绑定：未绑定则绑定；已绑定到别的实例 = 授权被复制（盗用信号）
    if (row.instanceKey === null) {
      this.db.bindInstance(row.licenseId, req.instanceKey)
      row = this.db.getLicense(row.licenseId) ?? row
    } else if (row.instanceKey !== req.instanceKey) {
      return fail(
        403,
        GENUINE_ERROR_CODES.instanceMismatch,
        `许可证 ${row.licenseId} 已绑定其他实例：同一份授权不能用于多个部署`,
      )
    }

    this.db.touchLastSeen(row.licenseId, now)
    const signed = this.signFor(row, now)
    return {
      ok: true,
      value: {
        licenseId: row.licenseId,
        status: signed.entitlement.status,
        heartbeatIntervalSec: row.heartbeatIntervalSec,
        graceSec: row.graceSec,
        issuedAt: signed.entitlement.issuedAt,
        license: signed,
      },
    }
  }

  heartbeat(req: HeartbeatRequest, now: number = Date.now()): ServiceResult<HeartbeatResponse> {
    if (!req.licenseId || !req.instanceKey) {
      return fail(400, GENUINE_ERROR_CODES.badRequest, 'licenseId / instanceKey 均为必填')
    }
    const row = this.db.getLicense(req.licenseId)
    if (!row)
      return fail(404, GENUINE_ERROR_CODES.licenseNotFound, `许可证不存在：${req.licenseId}`)
    if (row.instanceKey !== null && row.instanceKey !== req.instanceKey) {
      return fail(403, GENUINE_ERROR_CODES.instanceMismatch, 'instanceKey 与许可证绑定的实例不符')
    }
    this.db.touchLastSeen(row.licenseId, now)
    const signed = this.signFor(row, now)
    return {
      ok: true,
      value: {
        status: signed.entitlement.status,
        heartbeatIntervalSec: row.heartbeatIntervalSec,
        serverTime: signed.entitlement.serverTime,
        notice: signed.entitlement.notice ?? undefined,
        license: signed,
      },
    }
  }

  // ── 中心侧操作 ──

  issueLicense(input: IssueLicenseInput, now: number = Date.now()): ServiceResult<LicenseRow> {
    const product = this.db.getProduct(input.productId)
    if (!product) {
      return fail(404, GENUINE_ERROR_CODES.productNotFound, `产品不存在：${input.productId}`)
    }
    let expiresAt: number | null
    if (input.expiresAt !== undefined) expiresAt = input.expiresAt
    else if (input.expiresInDays !== undefined) expiresAt = now + input.expiresInDays * 86_400_000
    else expiresAt = ttlExpiry(product, now)

    const row = this.db.createLicense({
      licenseId: randomUUID(),
      productId: input.productId,
      appId: input.appId,
      licenseKey: input.licenseKey ?? null,
      expiresAt,
      enforcement: input.enforcement ?? product.defaultEnforcement,
      features: input.features ?? safeJsonArray(product.defaultFeatures),
      notice: input.notice ?? null,
      heartbeatIntervalSec: input.heartbeatIntervalSec,
      graceSec: input.graceSec,
    })
    return { ok: true, value: row }
  }

  /** 期限可随时调整：改 expiresAt 后下一次心跳即生效（消费侧也会在本地按 expiresAt 判定） */
  adjustLicense(
    licenseId: string,
    patch: Partial<{
      expiresAt: number | null
      expiresInDays: number
      enforcement: Enforcement
      features: string[]
      notice: string | null
      status: 'active' | 'suspended' | 'revoked'
      heartbeatIntervalSec: number
      graceSec: number
    }>,
    now: number = Date.now(),
  ): ServiceResult<LicenseRow> {
    const existing = this.db.getLicense(licenseId)
    if (!existing)
      return fail(404, GENUINE_ERROR_CODES.licenseNotFound, `许可证不存在：${licenseId}`)
    const { expiresInDays, ...rest } = patch
    if (expiresInDays !== undefined)
      rest.expiresAt = expiresInDays === null ? null : now + expiresInDays * 86_400_000
    const row = this.db.updateLicense(licenseId, rest)
    return row
      ? { ok: true, value: row }
      : fail(404, GENUINE_ERROR_CODES.licenseNotFound, licenseId)
  }

  /** 对外视图：不暴露私钥与 licenseKey 原文 */
  describe(row: LicenseRow, now: number = Date.now()) {
    return {
      licenseId: row.licenseId,
      productId: row.productId,
      appId: row.appId,
      instanceBound: row.instanceKey !== null,
      manualStatus: row.status,
      effectiveStatus: this.effectiveStatus(row, now),
      expiresAt: row.expiresAt === null ? null : new Date(row.expiresAt).toISOString(),
      expired: row.expiresAt !== null && now >= row.expiresAt,
      enforcement: row.enforcement,
      features: this.parseFeatures(row),
      notice: this.noticeFor(row, this.effectiveStatus(row, now), now),
      heartbeatIntervalSec: row.heartbeatIntervalSec,
      graceSec: row.graceSec,
      lastSeenAt: row.lastSeenAt === null ? null : new Date(row.lastSeenAt).toISOString(),
      createdAt: new Date(row.createdAt).toISOString(),
    }
  }

  /**
   * 对外视图（产品）：把 sqlite 存储怪味关在后端，与 describe() 对称。
   * 库里 allowSelfRegister 存 0/1（node:sqlite 不接受 boolean 绑定）、defaultFeatures 存 JSON 文本
   * （sqlite 无数组类型）——管理台不该关心这些，故此处转成真 boolean 与 string[]。
   */
  describeProduct(row: ProductRow): AdminProduct {
    return {
      id: row.id,
      name: row.name,
      defaultFeatures: safeJsonArray(row.defaultFeatures),
      defaultEnforcement: row.defaultEnforcement,
      defaultTtlDays: row.defaultTtlDays,
      allowSelfRegister: row.allowSelfRegister === 1,
      createdAt: new Date(row.createdAt).toISOString(),
    }
  }
}

function ttlExpiry(product: ProductRow, now: number): number | null {
  return product.defaultTtlDays === null ? null : now + product.defaultTtlDays * 86_400_000
}

function safeJsonArray(text: string): string[] {
  try {
    const parsed: unknown = JSON.parse(text)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}
