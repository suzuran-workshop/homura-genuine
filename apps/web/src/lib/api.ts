/**
 * 管理台 API 客户端：裸 fetch + 轻封装（不引 tanstack-query，符合本仓库极简哲学）。
 *
 * 设计成可注入（createApi）：lib/api.ts 是纯逻辑、无 DOM，测试时传 stub fetch + 假 getToken，
 * 走 node 环境即可，不必装 jsdom。
 *
 * 401 与 503 的分流对应后端语义，是鉴权体验的关键：
 * - 503 = 服务端未配 GENUINE_ADMIN_TOKEN（管理接口整体禁用）→ 不清会话，提示「服务端未启用管理接口」
 * - 401 = token 无效 → 登录页内联报错；其他页面清会话 + 广播登出
 * - 401 还要过「陈旧防护」：登录前发出的请求返回的 401 描述的是旧会话，不能踢掉新会话
 */
import type {
  AdminKey,
  AdminLicense,
  AdminProduct,
  AdjustLicenseBody,
  HealthResponse,
  IssueLicenseBody,
  KeysResponse,
  LicensesResponse,
  LicenseResponse,
  ProductResponse,
  ProductsResponse,
  RotateKeyResponse,
  UpsertProductBody,
} from '@homura-genuine/contract/admin'
import { getToken as readToken, isStaleAuth } from './auth.ts'

/** 后端错误信封（与 contract 的 GenuineErrorBody 同形，此处独立声明以免运行期 import 契约值） */
interface ErrorBody {
  error: string
  message: string
}

export type ApiErrorKind =
  | 'unauthorized' // 401：token 无效
  | 'admin-disabled' // 503：服务端未配 token
  | 'not-found' // 404
  | 'bad-request' // 400
  | 'network' // 请求未到达服务端（fetch reject）
  | 'server' // 5xx 其他
  | 'unknown'

export class ApiError extends Error {
  readonly status: number
  readonly kind: ApiErrorKind
  readonly code: string

  constructor(status: number, kind: ApiErrorKind, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.kind = kind
    this.code = code
  }
}

function kindOf(status: number, code: string): ApiErrorKind {
  if (status === 401) return 'unauthorized'
  if (status === 503) return 'admin-disabled'
  if (status === 404 || code === 'license_not_found' || code === 'product_not_found')
    return 'not-found'
  if (status === 400 || code === 'bad_request') return 'bad-request'
  if (status >= 500) return 'server'
  return 'unknown'
}

export interface ApiOptions {
  /** 注入 fetch（测试用）；缺省全局 fetch */
  fetchImpl?: typeof fetch
  /** 注入 token 读取（测试用）；缺省读 sessionStorage */
  getToken?: () => string | null
  /** 401（非陈旧）时的回调：清会话 + 跳登录。仅在已登录场景触发 */
  onUnauthorized?: () => void
  /** 请求发起时刻；缺省 Date.now()。用于陈旧 401 判定 */
  now?: () => number
}

export interface Api {
  health(): Promise<HealthResponse>
  listProducts(): Promise<AdminProduct[]>
  upsertProduct(id: string, body: UpsertProductBody): Promise<AdminProduct>
  listLicenses(filter?: { productId?: string; appId?: string }): Promise<AdminLicense[]>
  getLicense(id: string): Promise<AdminLicense>
  issueLicense(body: IssueLicenseBody): Promise<AdminLicense>
  adjustLicense(id: string, body: AdjustLicenseBody): Promise<AdminLicense>
  listKeys(): Promise<AdminKey[]>
  rotateKey(): Promise<RotateKeyResponse>
}

export function createApi(opts: ApiOptions = {}): Api {
  const doFetch = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a))
  const getToken = opts.getToken ?? readToken
  const now = opts.now ?? (() => Date.now())

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const startedAt = now()
    const token = getToken()
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    }
    if (token) headers['Authorization'] = `Bearer ${token}`
    if (init.body !== undefined && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json'
    }

    let res: Response
    try {
      res = await doFetch(path, { ...init, headers })
    } catch (err) {
      throw new ApiError(0, 'network', 'network_error', (err as Error).message || '网络请求失败')
    }

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as Partial<ErrorBody>
      const code = body.error ?? ''
      const message = body.message ?? `请求失败（HTTP ${res.status}）`
      // 401 分流：陈旧 401 丢弃；否则（已登录场景）广播登出
      if (res.status === 401 && !isStaleAuth(startedAt) && token) {
        opts.onUnauthorized?.()
      }
      throw new ApiError(res.status, kindOf(res.status, code), code, message)
    }

    return (await res.json()) as T
  }

  const qs = (filter?: { productId?: string; appId?: string }): string => {
    if (!filter) return ''
    const p = new URLSearchParams()
    if (filter.productId) p.set('productId', filter.productId)
    if (filter.appId) p.set('appId', filter.appId)
    const s = p.toString()
    return s ? `?${s}` : ''
  }

  return {
    // /healthz 无需鉴权，用于总览页显示服务健康
    health: () => request<HealthResponse>('/healthz'),

    listProducts: async () => (await request<ProductsResponse>('/admin/products')).products,
    upsertProduct: async (id, body) =>
      (
        await request<ProductResponse>(`/admin/products/${encodeURIComponent(id)}`, {
          method: 'PUT',
          body: JSON.stringify(body),
        })
      ).product,

    listLicenses: async (filter) =>
      (await request<LicensesResponse>(`/admin/licenses${qs(filter)}`)).licenses,
    getLicense: async (id) =>
      (await request<LicenseResponse>(`/admin/licenses/${encodeURIComponent(id)}`)).license,
    issueLicense: async (body) =>
      (
        await request<LicenseResponse>('/admin/licenses', {
          method: 'POST',
          body: JSON.stringify(body),
        })
      ).license,
    adjustLicense: async (id, body) =>
      (
        await request<LicenseResponse>(`/admin/licenses/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        })
      ).license,

    listKeys: async () => (await request<KeysResponse>('/admin/keys')).keys,
    rotateKey: () => request<RotateKeyResponse>('/admin/keys/rotate', { method: 'POST' }),
  }
}

/** 默认单例：用 sessionStorage 的 token；401 时派发全局事件，由 App 顶层监听后跳登录 */
export const api = createApi({
  onUnauthorized: () => {
    // 节流由监听方处理；此处只广播
    window.dispatchEvent(new CustomEvent('genuine:unauthorized'))
  },
})
