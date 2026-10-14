/**
 * 存储层：node:sqlite 单文件库（零外部依赖，与 homura 的 sqlite 方言同一路子）。
 *
 * 为什么不用 ORM：中心侧表少、查询直白，且本仓库刻意不依赖 homura 的任何包
 * （契约靠逐字同步的 contract.ts，不靠 import），避免"授权中心依赖被授权方"的反向耦合。
 *
 * 布尔一律存 0/1（node:sqlite 不接受 JS boolean 绑定）；时间一律 ms epoch 整数；
 * features 存 JSON 文本。
 */
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Enforcement } from './contract.js'

/** 中心手动状态（有效状态还要叠加到期计算，见 service.ts） */
export type ManualStatus = 'active' | 'suspended' | 'revoked'

export interface ProductRow {
  id: string
  name: string
  /** JSON 数组文本 */
  defaultFeatures: string
  defaultEnforcement: Enforcement
  /** 新签发许可证的默认有效期（天）；null = 永不过期 */
  defaultTtlDays: number | null
  /** 1 = 允许 App 首次注册时自助签发（方便自家 App；对外分发应设 0） */
  allowSelfRegister: number
  createdAt: number
}

export interface LicenseRow {
  licenseId: string
  productId: string
  appId: string
  /** 首次注册时绑定；null = 尚未绑定实例 */
  instanceKey: string | null
  licenseKey: string | null
  status: ManualStatus
  /** ms epoch；null = 永不过期 */
  expiresAt: number | null
  enforcement: Enforcement
  /** JSON 数组文本 */
  features: string
  notice: string | null
  heartbeatIntervalSec: number
  graceSec: number
  createdAt: number
  updatedAt: number
  lastSeenAt: number | null
}

export interface SigningKeyRow {
  keyId: string
  publicPem: string
  privatePem: string
  createdAt: number
  retiredAt: number | null
}

const DDL = `
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  default_features TEXT NOT NULL DEFAULT '[]',
  default_enforcement TEXT NOT NULL DEFAULT 'all',
  default_ttl_days INTEGER,
  allow_self_register INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS licenses (
  license_id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  instance_key TEXT,
  license_key TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  expires_at INTEGER,
  enforcement TEXT NOT NULL DEFAULT 'all',
  features TEXT NOT NULL DEFAULT '[]',
  notice TEXT,
  heartbeat_interval_sec INTEGER NOT NULL DEFAULT 300,
  grace_sec INTEGER NOT NULL DEFAULT 86400,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_seen_at INTEGER
);
CREATE INDEX IF NOT EXISTS licenses_product_idx ON licenses (product_id);
CREATE INDEX IF NOT EXISTS licenses_instance_idx ON licenses (product_id, app_id, instance_key);
CREATE UNIQUE INDEX IF NOT EXISTS licenses_key_idx ON licenses (license_key) WHERE license_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS signing_keys (
  key_id TEXT PRIMARY KEY,
  public_pem TEXT NOT NULL,
  private_pem TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  retired_at INTEGER
);
`

export class GenuineDb {
  private readonly db: DatabaseSync

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec(DDL)
  }

  close(): void {
    this.db.close()
  }

  // ── products ──

  upsertProduct(p: {
    id: string
    name: string
    defaultFeatures: string[]
    defaultEnforcement: Enforcement
    defaultTtlDays: number | null
    allowSelfRegister: boolean
  }): ProductRow {
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO products (id, name, default_features, default_enforcement, default_ttl_days, allow_self_register, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           name = excluded.name,
           default_features = excluded.default_features,
           default_enforcement = excluded.default_enforcement,
           default_ttl_days = excluded.default_ttl_days,
           allow_self_register = excluded.allow_self_register`,
      )
      .run(
        p.id,
        p.name,
        JSON.stringify(p.defaultFeatures),
        p.defaultEnforcement,
        p.defaultTtlDays,
        p.allowSelfRegister ? 1 : 0,
        now,
      )
    const row = this.getProduct(p.id)
    if (!row) throw new Error(`product 写入后读不回：${p.id}`)
    return row
  }

  getProduct(id: string): ProductRow | null {
    const row = this.db
      .prepare(
        `SELECT id, name, default_features AS defaultFeatures, default_enforcement AS defaultEnforcement,
                default_ttl_days AS defaultTtlDays, allow_self_register AS allowSelfRegister, created_at AS createdAt
         FROM products WHERE id = ?`,
      )
      .get(id) as ProductRow | undefined
    return row ?? null
  }

  listProducts(): ProductRow[] {
    return this.db
      .prepare(
        `SELECT id, name, default_features AS defaultFeatures, default_enforcement AS defaultEnforcement,
                default_ttl_days AS defaultTtlDays, allow_self_register AS allowSelfRegister, created_at AS createdAt
         FROM products ORDER BY id`,
      )
      .all() as unknown as ProductRow[]
  }

  // ── licenses ──

  createLicense(l: {
    licenseId: string
    productId: string
    appId: string
    licenseKey?: string | null
    expiresAt?: number | null
    enforcement?: Enforcement
    features?: string[]
    notice?: string | null
    heartbeatIntervalSec?: number
    graceSec?: number
  }): LicenseRow {
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO licenses (license_id, product_id, app_id, instance_key, license_key, status, expires_at,
                               enforcement, features, notice, heartbeat_interval_sec, grace_sec,
                               created_at, updated_at, last_seen_at)
         VALUES (?, ?, ?, NULL, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        l.licenseId,
        l.productId,
        l.appId,
        l.licenseKey ?? null,
        l.expiresAt ?? null,
        l.enforcement ?? 'all',
        JSON.stringify(l.features ?? []),
        l.notice ?? null,
        l.heartbeatIntervalSec ?? 300,
        l.graceSec ?? 86400,
        now,
        now,
      )
    const row = this.getLicense(l.licenseId)
    if (!row) throw new Error(`license 写入后读不回：${l.licenseId}`)
    return row
  }

  getLicense(licenseId: string): LicenseRow | null {
    return (
      (this.db
        .prepare(`SELECT ${LICENSE_COLS} FROM licenses WHERE license_id = ?`)
        .get(licenseId) as LicenseRow | undefined) ?? null
    )
  }

  /** 注册查找顺序：licenseKey 精确命中 → (product, app, instanceKey) 已绑定实例 */
  findLicenseForRegister(
    productId: string,
    appId: string,
    instanceKey: string,
    licenseKey?: string,
  ): LicenseRow | null {
    if (licenseKey) {
      const byKey = this.db
        .prepare(`SELECT ${LICENSE_COLS} FROM licenses WHERE license_key = ?`)
        .get(licenseKey) as LicenseRow | undefined
      if (byKey) return byKey
    }
    const byInstance = this.db
      .prepare(
        `SELECT ${LICENSE_COLS} FROM licenses WHERE product_id = ? AND app_id = ? AND instance_key = ?`,
      )
      .get(productId, appId, instanceKey) as LicenseRow | undefined
    return byInstance ?? null
  }

  /** 中心调整许可（到期时间、处置强度、功能范围、提醒文案、手动状态）——期限可随时改 */
  updateLicense(
    licenseId: string,
    patch: Partial<{
      expiresAt: number | null
      enforcement: Enforcement
      features: string[]
      notice: string | null
      status: ManualStatus
      heartbeatIntervalSec: number
      graceSec: number
    }>,
  ): LicenseRow | null {
    const sets: string[] = []
    const args: Array<string | number | null> = []
    if (patch.expiresAt !== undefined) {
      sets.push('expires_at = ?')
      args.push(patch.expiresAt)
    }
    if (patch.enforcement !== undefined) {
      sets.push('enforcement = ?')
      args.push(patch.enforcement)
    }
    if (patch.features !== undefined) {
      sets.push('features = ?')
      args.push(JSON.stringify(patch.features))
    }
    if (patch.notice !== undefined) {
      sets.push('notice = ?')
      args.push(patch.notice)
    }
    if (patch.status !== undefined) {
      sets.push('status = ?')
      args.push(patch.status)
    }
    if (patch.heartbeatIntervalSec !== undefined) {
      sets.push('heartbeat_interval_sec = ?')
      args.push(patch.heartbeatIntervalSec)
    }
    if (patch.graceSec !== undefined) {
      sets.push('grace_sec = ?')
      args.push(patch.graceSec)
    }
    if (sets.length === 0) return this.getLicense(licenseId)
    sets.push('updated_at = ?')
    args.push(Date.now())
    args.push(licenseId)
    this.db.prepare(`UPDATE licenses SET ${sets.join(', ')} WHERE license_id = ?`).run(...args)
    return this.getLicense(licenseId)
  }

  /** 首次注册绑定实例；已绑定到其他实例则返回 false（盗用信号） */
  bindInstance(licenseId: string, instanceKey: string): boolean {
    const res = this.db
      .prepare(
        'UPDATE licenses SET instance_key = ?, updated_at = ? WHERE license_id = ? AND instance_key IS NULL',
      )
      .run(instanceKey, Date.now(), licenseId)
    return Number(res.changes) > 0
  }

  touchLastSeen(licenseId: string, ts: number): void {
    this.db.prepare('UPDATE licenses SET last_seen_at = ? WHERE license_id = ?').run(ts, licenseId)
  }

  listLicenses(filter: { productId?: string; appId?: string } = {}): LicenseRow[] {
    const where: string[] = []
    const args: string[] = []
    if (filter.productId) {
      where.push('product_id = ?')
      args.push(filter.productId)
    }
    if (filter.appId) {
      where.push('app_id = ?')
      args.push(filter.appId)
    }
    const sql = `SELECT ${LICENSE_COLS} FROM licenses${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC`
    return this.db.prepare(sql).all(...args) as unknown as LicenseRow[]
  }

  // ── signing keys ──

  addSigningKey(k: { keyId: string; publicPem: string; privatePem: string }): SigningKeyRow {
    this.db
      .prepare(
        'INSERT INTO signing_keys (key_id, public_pem, private_pem, created_at, retired_at) VALUES (?, ?, ?, ?, NULL)',
      )
      .run(k.keyId, k.publicPem, k.privatePem, Date.now())
    return {
      keyId: k.keyId,
      publicPem: k.publicPem,
      privatePem: k.privatePem,
      createdAt: Date.now(),
      retiredAt: null,
    }
  }

  /** 当前签发用密钥：未退休的最新一把 */
  getActiveSigningKey(): SigningKeyRow | null {
    return (
      (this.db
        .prepare(
          'SELECT key_id AS keyId, public_pem AS publicPem, private_pem AS privatePem, created_at AS createdAt, retired_at AS retiredAt FROM signing_keys WHERE retired_at IS NULL ORDER BY created_at DESC LIMIT 1',
        )
        .get() as SigningKeyRow | undefined) ?? null
    )
  }

  getSigningKey(keyId: string): SigningKeyRow | null {
    return (
      (this.db
        .prepare(
          'SELECT key_id AS keyId, public_pem AS publicPem, private_pem AS privatePem, created_at AS createdAt, retired_at AS retiredAt FROM signing_keys WHERE key_id = ?',
        )
        .get(keyId) as SigningKeyRow | undefined) ?? null
    )
  }

  listSigningKeys(): Array<{
    keyId: string
    publicPem: string
    createdAt: number
    retiredAt: number | null
  }> {
    return this.db
      .prepare(
        'SELECT key_id AS keyId, public_pem AS publicPem, created_at AS createdAt, retired_at AS retiredAt FROM signing_keys ORDER BY created_at DESC',
      )
      .all() as Array<{
      keyId: string
      publicPem: string
      createdAt: number
      retiredAt: number | null
    }>
  }

  /** 轮换：旧钥匙标记退休（仍可验签历史响应），新钥匙成为签发用 */
  retireSigningKey(keyId: string): void {
    this.db
      .prepare('UPDATE signing_keys SET retired_at = ? WHERE key_id = ?')
      .run(Date.now(), keyId)
  }
}

const LICENSE_COLS = `license_id AS licenseId, product_id AS productId, app_id AS appId,
  instance_key AS instanceKey, license_key AS licenseKey, status, expires_at AS expiresAt,
  enforcement, features, notice, heartbeat_interval_sec AS heartbeatIntervalSec,
  grace_sec AS graceSec, created_at AS createdAt, updated_at AS updatedAt, last_seen_at AS lastSeenAt`
