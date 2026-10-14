/**
 * 管理端点（/admin/*）的请求/响应类型——中心内部契约，**不属于跨仓库同步范围**。
 *
 * ⚠ 本文件与 contract.ts 的关键区别：
 *   - contract.ts 是与 ../homura 逐字同步的公开契约（App 侧也依赖），且只允许 Node 内置；
 *   - admin.ts 是中心运营端（web 管理台）自己的类型，App 侧永远不该调 /admin/*，
 *     故不纳入 parity 比对、可自由演进。
 *
 * ⚠ 安全红线（会静默失效，务必遵守）：本文件**只允许 `import type` from './contract.ts'**，
 *   禁止 `export *`、禁止 re-export contract 的任何**运行值**（如 GENUINE_ERROR_CODES）。
 *   contract.ts 顶部 `import ... from 'node:crypto'`——一旦有运行值被 re-export 出去，
 *   web 侧 `import { X } from '.../admin'` 就会把 node:crypto 拖进浏览器 bundle；
 *   而 Vite 对此只报 warning 不失败，运行时才白屏。全部用类型即可根除这条泄漏路径。
 */
import type { Enforcement, LicenseStatus } from './contract.ts'

/** 中心手动状态（与 db.ts 的 ManualStatus 一致；有效状态另见 effectiveStatus） */
export type ManualStatus = 'active' | 'suspended' | 'revoked'

/**
 * `expiresAt` 在管理端点接受三种形态：
 * - ms epoch 数字（App/脚本用）
 * - ISO-8601 字符串（web 表单用）
 * - null = 永不过期
 * 后端 `parseExpiry` 统一解析。
 */
export type ExpiryInput = number | string | null

// ─────────────── 产品 ───────────────

/**
 * `GET /admin/products` 列表项、`PUT /admin/products/:id` 响应里的 product。
 *
 * 这是**对外干净形状**（由 service.describeProduct 产出），已把 sqlite 存储怪味关在后端：
 * `allowSelfRegister` 是真正的 boolean（库里存 0/1）、`defaultFeatures` 是 string[]（库里存 JSON 文本）。
 */
export interface AdminProduct {
  id: string
  name: string
  defaultFeatures: string[]
  defaultEnforcement: Enforcement
  /** 新签发许可证的默认有效期（天）；null = 永不过期 */
  defaultTtlDays: number | null
  /** true = 允许 App 首次注册时自助签发（ADR-007：开启即放弃实例管控） */
  allowSelfRegister: boolean
  /** ISO-8601 */
  createdAt: string
}

/** `PUT /admin/products/:id` 请求体（全可选，缺省见 app.ts 的兜底规则） */
export interface UpsertProductBody {
  name?: string
  defaultFeatures?: string[]
  defaultEnforcement?: Enforcement
  defaultTtlDays?: number | null
  allowSelfRegister?: boolean
}

// ─────────────── 许可证 ───────────────

/**
 * `describe()` 产出的对外授权视图（15 字段）：`GET /admin/licenses` 列表项、
 * `GET /admin/licenses/:id`、`POST /admin/licenses`、`PATCH /admin/licenses/:id` 响应里的 license。
 *
 * **不含** licenseKey 原文与私钥（service.describe 的硬约定）。
 */
export interface AdminLicense {
  licenseId: string
  productId: string
  appId: string
  /** 是否已绑定实例（instanceKey !== null） */
  instanceBound: boolean
  /** 手动状态（库里存的） */
  manualStatus: ManualStatus
  /** 有效状态（叠加到期算出来的，见 service.effectiveStatus） */
  effectiveStatus: LicenseStatus
  /** ISO-8601；null = 永不过期 */
  expiresAt: string | null
  /** 是否已过 expiresAt */
  expired: boolean
  enforcement: Enforcement
  features: string[]
  notice: string | null
  heartbeatIntervalSec: number
  graceSec: number
  /** ISO-8601；null = 从未心跳 */
  lastSeenAt: string | null
  /** ISO-8601 */
  createdAt: string
}

/** `POST /admin/licenses` 请求体（productId、appId 必填） */
export interface IssueLicenseBody {
  productId: string
  appId: string
  licenseKey?: string | null
  expiresAt?: ExpiryInput
  expiresInDays?: number
  enforcement?: Enforcement
  features?: string[]
  notice?: string | null
  heartbeatIntervalSec?: number
  graceSec?: number
}

/** `PATCH /admin/licenses/:id` 请求体（全可选；undefined = 不改，null = 清空） */
export interface AdjustLicenseBody {
  expiresAt?: ExpiryInput
  expiresInDays?: number
  enforcement?: Enforcement
  features?: string[]
  notice?: string | null
  status?: ManualStatus
  heartbeatIntervalSec?: number
  graceSec?: number
}

// ─────────────── 签名密钥 ───────────────

/** `GET /admin/keys` 与 `GET /v1/keys` 的密钥项（不含私钥） */
export interface AdminKey {
  keyId: string
  /** Ed25519 公钥 PEM（SPKI），可公开分发/复制 */
  publicKey: string
  /** ISO-8601（仅 /admin/keys 有；/v1/keys 无此字段） */
  createdAt?: string
  retired: boolean
}

/** `POST /admin/keys/rotate` 响应 */
export interface RotateKeyResponse {
  keyId: string
  publicKey: string
}

// ─────────────── 响应信封 ───────────────

export interface ProductsResponse {
  products: AdminProduct[]
}
export interface ProductResponse {
  product: AdminProduct
}
export interface LicensesResponse {
  licenses: AdminLicense[]
}
export interface LicenseResponse {
  license: AdminLicense
}
export interface KeysResponse {
  keys: AdminKey[]
}
export interface HealthResponse {
  status: string
  service: string
}
