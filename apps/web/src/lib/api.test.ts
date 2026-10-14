import { describe, expect, it, vi } from 'vitest'
import { markLogin } from './auth.ts'
import { ApiError, createApi } from './api.ts'

/**
 * api.ts 的行为契约：注入 Authorization、401/503 分流、陈旧 401 防护、错误信封解析、
 * 列表/详情/写操作的响应解包。全程注入 stub fetch，走 node 环境，不碰 DOM。
 */

function ok(json: unknown, status = 200): Response {
  return new Response(JSON.stringify(json), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function fail(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/**
 * 带 fetch 参数签名的 stub 工厂：让 mock.calls[0] 的类型是 [input, init]，
 * 而不是 `vi.fn(async () => ...)` 推断出的空元组 []（那样取 [0]/[1] 会报 TS2493）。
 */
function mockFetch(resolver: (input: string, init?: RequestInit) => Response | Promise<Response>) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(resolver(String(input), init)),
  )
}

describe('createApi — 鉴权头注入', () => {
  it('有 token → 带 Authorization: Bearer', async () => {
    const fetchImpl = mockFetch(() => ok({ products: [] }))
    const api = createApi({ fetchImpl, getToken: () => 'tok' })
    await api.listProducts()
    const init = fetchImpl.mock.calls[0]![1]!
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer tok')
  })

  it('无 token → 不带 Authorization 头', async () => {
    const fetchImpl = mockFetch(() => ok({ products: [] }))
    const api = createApi({ fetchImpl, getToken: () => null })
    await api.listProducts()
    const init = fetchImpl.mock.calls[0]![1]!
    expect((init.headers as Record<string, string>)['Authorization']).toBeUndefined()
  })
})

describe('createApi — 401/503 分流', () => {
  it('503（服务端未配 token）→ kind=admin-disabled，不触发 onUnauthorized', async () => {
    const onUnauthorized = vi.fn()
    const api = createApi({
      fetchImpl: mockFetch(() => fail(503, 'unauthorized', '未配置 GENUINE_ADMIN_TOKEN')),
      getToken: () => 'tok',
      onUnauthorized,
    })
    await expect(api.listProducts()).rejects.toMatchObject({ kind: 'admin-disabled', status: 503 })
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it('401（token 错，已登录）→ kind=unauthorized，触发 onUnauthorized', async () => {
    const onUnauthorized = vi.fn()
    const api = createApi({
      fetchImpl: mockFetch(() => fail(401, 'unauthorized', 'bearer token 无效')),
      getToken: () => 'tok',
      onUnauthorized,
      now: () => 1_000_000, // 请求发起晚于登录时刻（默认 lastLoginAt=0）→ 非陈旧
    })
    await expect(api.listProducts()).rejects.toBeInstanceOf(ApiError)
    expect(onUnauthorized).toHaveBeenCalledOnce()
  })

  it('陈旧 401（请求发起早于登录）→ 不触发 onUnauthorized', async () => {
    const onUnauthorized = vi.fn()
    markLogin(1000) // 登录时刻固定在 t=1000
    // now() 返回 t=0（请求发起早于登录）→ isStaleAuth(0)=true → 陈旧，丢弃该 401
    const api = createApi({
      fetchImpl: mockFetch(() => fail(401, 'unauthorized', 'x')),
      getToken: () => 'tok',
      onUnauthorized,
      now: () => 0,
    })
    await expect(api.listProducts()).rejects.toBeInstanceOf(ApiError)
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it('网络失败（fetch reject）→ kind=network，不触发 onUnauthorized', async () => {
    const onUnauthorized = vi.fn()
    const api = createApi({
      fetchImpl: mockFetch(() => {
        throw new Error('ECONNREFUSED')
      }),
      getToken: () => 'tok',
      onUnauthorized,
    })
    await expect(api.listProducts()).rejects.toMatchObject({ kind: 'network', status: 0 })
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it('404 → kind=not-found', async () => {
    const api = createApi({
      fetchImpl: mockFetch(() => fail(404, 'license_not_found', '不存在')),
      getToken: () => 'tok',
    })
    await expect(api.getLicense('x')).rejects.toMatchObject({ kind: 'not-found', status: 404 })
  })
})

describe('createApi — 响应解包与查询串', () => {
  it('listProducts 解包 { products }', async () => {
    const api = createApi({
      fetchImpl: mockFetch(() => ok({ products: [{ id: 'p1' }] })),
      getToken: () => 'tok',
    })
    await expect(api.listProducts()).resolves.toEqual([{ id: 'p1' }])
  })

  it('listLicenses 带过滤 → 拼 productId/appId 查询串', async () => {
    const fetchImpl = mockFetch(() => ok({ licenses: [] }))
    const api = createApi({ fetchImpl, getToken: () => 'tok' })
    await api.listLicenses({ productId: 'pro', appId: 'app-1' })
    expect(fetchImpl.mock.calls[0]![0]).toBe('/admin/licenses?productId=pro&appId=app-1')
  })

  it('写操作带 body → 设 Content-Type 且 method 正确', async () => {
    const fetchImpl = mockFetch(() => ok({ license: { licenseId: 'L1' } }, 201))
    const api = createApi({ fetchImpl, getToken: () => 'tok' })
    await api.issueLicense({ productId: 'p', appId: 'a' })
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('/admin/licenses')
    expect(init!.method).toBe('POST')
    expect(init!.headers).toMatchObject({ 'Content-Type': 'application/json' })
  })

  it('rotateKey → POST /admin/keys/rotate 返回 { keyId, publicKey }', async () => {
    const fetchImpl = mockFetch(() => ok({ keyId: 'k2', publicKey: 'PEM' }))
    const api = createApi({ fetchImpl, getToken: () => 'tok' })
    await expect(api.rotateKey()).resolves.toEqual({ keyId: 'k2', publicKey: 'PEM' })
    expect(fetchImpl.mock.calls[0]![0]).toBe('/admin/keys/rotate')
  })

  it('health 无需 token 也可调（总览页用）', async () => {
    const api = createApi({
      fetchImpl: mockFetch(() => ok({ status: 'ok', service: 'homura-genuine' })),
      getToken: () => null,
    })
    await expect(api.health()).resolves.toMatchObject({ status: 'ok' })
  })
})
