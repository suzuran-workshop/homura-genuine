import { describe, expect, it } from 'vitest'
import type { HeartbeatResponse, RegisterResponse } from './contract.js'
import { verifyEntitlement } from './contract.js'
import { buildApp } from './app.js'
import { GenuineDb } from './db.js'

const TOKEN = 'admin-token-abc'

function setup(adminToken: string | null = TOKEN) {
  const db = new GenuineDb(':memory:')
  const built = buildApp({ db, adminToken })
  return { ...built, auth: { authorization: `Bearer ${TOKEN}` } }
}

const json = { 'content-type': 'application/json' }

describe('公开端点', () => {
  it('/healthz → ok', async () => {
    const { app } = setup()
    const res = await app.request('/healthz')
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ status: 'ok' })
  })

  it('/v1/keys 只给公钥，绝不泄露私钥', async () => {
    const { app, db } = setup()
    const res = await app.request('/v1/keys')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { keys: Array<{ keyId: string; publicKey: string }> }
    expect(body.keys).toHaveLength(1)
    expect(body.keys[0]!.publicKey).toContain('PUBLIC KEY')
    // 公钥可公开，私钥绝不能出现在任何响应里
    expect(JSON.stringify(body)).not.toContain('PRIVATE KEY')
  })

  it('未知路径 → 404 JSON（不是 HTML）', async () => {
    const { app } = setup()
    const res = await app.request('/nope')
    expect(res.status).toBe(404)
    await expect(res.json()).resolves.toMatchObject({ error: 'not_found' })
  })

  it('非 JSON 请求体 → 400 而不是 500', async () => {
    const { app } = setup()
    const res = await app.request('/v1/register', { method: 'POST', body: 'not-json' })
    expect(res.status).toBe(400)
  })
})

describe('管理端点鉴权', () => {
  it('未配置 GENUINE_ADMIN_TOKEN → /admin/* 全部 503（不允许裸奔）', async () => {
    const { app } = setup(null)
    const res = await app.request('/admin/licenses')
    expect(res.status).toBe(503)
    await expect(res.json()).resolves.toMatchObject({ error: 'unauthorized' })
  })

  it('token 错误 → 401；正确 → 200', async () => {
    const { app } = setup()
    expect(
      (await app.request('/admin/licenses', { headers: { authorization: 'Bearer wrong' } })).status,
    ).toBe(401)
    expect(
      (await app.request('/admin/licenses', { headers: { authorization: `Bearer ${TOKEN}` } }))
        .status,
    ).toBe(200)
  })

  it('非 Bearer 形式一律拒', async () => {
    const { app } = setup()
    expect(
      (await app.request('/admin/licenses', { headers: { authorization: TOKEN } })).status,
    ).toBe(401)
  })
})

describe('端到端：签发 → 注册 → 心跳 → 到期 → 续期（全部走 HTTP）', () => {
  it('完整生命周期', async () => {
    const { app, auth, service } = setup()
    const publicKey = service.activeKey()!.publicPem

    // ① 建产品（默认 30 天、功能范围 basic、到期后禁全部）
    const putProduct = await app.request('/admin/products/tpl', {
      method: 'PUT',
      headers: { ...json, ...auth },
      body: JSON.stringify({
        name: '模板产品',
        defaultFeatures: ['basic'],
        defaultEnforcement: 'all',
        defaultTtlDays: 30,
        allowSelfRegister: true,
      }),
    })
    expect(putProduct.status).toBe(200)

    // ② App 首次注册
    const regRes = await app.request('/v1/register', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ productId: 'tpl', appId: 'app-1', instanceKey: 'inst-1' }),
    })
    expect(regRes.status).toBe(200)
    const reg = (await regRes.json()) as RegisterResponse
    expect(reg.status).toBe('active')
    expect(verifyEntitlement(reg.license, publicKey)).toEqual({ ok: true })
    expect(reg.license.entitlement.features).toEqual(['basic'])
    expect(reg.license.entitlement.expiresAt).not.toBeNull()

    // ③ 心跳正常
    const beat = async () => {
      const r = await app.request('/v1/heartbeat', {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ licenseId: reg.licenseId, instanceKey: 'inst-1' }),
      })
      expect(r.status).toBe(200)
      return (await r.json()) as HeartbeatResponse
    }
    expect((await beat()).status).toBe('active')

    // ④ 中心把期限改成已过期 → 下一次心跳立即下发 expired + 强提醒
    const expire = await app.request(`/admin/licenses/${reg.licenseId}`, {
      method: 'PATCH',
      headers: { ...json, ...auth },
      body: JSON.stringify({ expiresInDays: -1 }),
    })
    expect(expire.status).toBe(200)
    const expiredBeat = await beat()
    expect(expiredBeat.status).toBe('expired')
    expect(expiredBeat.notice).toMatch(/到期/)
    expect(expiredBeat.license.entitlement.enforcement).toBe('all')
    expect(verifyEntitlement(expiredBeat.license, publicKey)).toEqual({ ok: true })

    // ⑤ 改成"只提醒不禁用"→ 状态仍 expired，但处置强度变了
    await app.request(`/admin/licenses/${reg.licenseId}`, {
      method: 'PATCH',
      headers: { ...json, ...auth },
      body: JSON.stringify({ enforcement: 'notice' }),
    })
    expect((await beat()).license.entitlement.enforcement).toBe('notice')

    // ⑥ 追加功能范围（不同许可证开放不同能力）
    await app.request(`/admin/licenses/${reg.licenseId}`, {
      method: 'PATCH',
      headers: { ...json, ...auth },
      body: JSON.stringify({ features: ['basic', 'export', 'ai'] }),
    })
    expect((await beat()).license.entitlement.features).toEqual(['basic', 'export', 'ai'])

    // ⑦ 续期 → 立即回到 active，提醒消失
    await app.request(`/admin/licenses/${reg.licenseId}`, {
      method: 'PATCH',
      headers: { ...json, ...auth },
      body: JSON.stringify({ expiresInDays: 30 }),
    })
    const renewed = await beat()
    expect(renewed.status).toBe('active')
    expect(renewed.license.entitlement.notice).toBeNull()
    expect(renewed.license.entitlement.enforcement).toBe('none')

    // ⑧ 手动停服优先于一切
    await app.request(`/admin/licenses/${reg.licenseId}`, {
      method: 'PATCH',
      headers: { ...json, ...auth },
      body: JSON.stringify({ status: 'suspended' }),
    })
    expect((await beat()).status).toBe('suspended')
  })

  it('预签发许可证（不开自助注册）→ 用 licenseKey 注册', async () => {
    const { app, auth } = setup()
    await app.request('/admin/products/pro', {
      method: 'PUT',
      headers: { ...json, ...auth },
      body: JSON.stringify({ name: 'Pro', defaultFeatures: ['pro'], defaultTtlDays: 365 }),
    })
    const issue = await app.request('/admin/licenses', {
      method: 'POST',
      headers: { ...json, ...auth },
      body: JSON.stringify({
        productId: 'pro',
        appId: 'app-2',
        licenseKey: 'LIC-KEY-1',
        expiresInDays: 365,
      }),
    })
    expect(issue.status).toBe(201)
    const issued = (await issue.json()) as { license: { licenseId: string; features: string[] } }
    expect(issued.license.features).toEqual(['pro'])

    const reg = await app.request('/v1/register', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({
        productId: 'pro',
        appId: 'app-2',
        instanceKey: 'i2',
        licenseKey: 'LIC-KEY-1',
      }),
    })
    expect(reg.status).toBe(200)
    expect(((await reg.json()) as RegisterResponse).licenseId).toBe(issued.license.licenseId)

    // 未开自助注册且无 key → 403
    const denied = await app.request('/v1/register', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ productId: 'pro', appId: 'app-3', instanceKey: 'i3' }),
    })
    expect(denied.status).toBe(403)
    await expect(denied.json()).resolves.toMatchObject({ error: 'self_register_disabled' })
  })

  it('管理接口参数校验：缺 productId → 400；许可不存在 → 404', async () => {
    const { app, auth } = setup()
    const bad = await app.request('/admin/licenses', {
      method: 'POST',
      headers: { ...json, ...auth },
      body: JSON.stringify({ appId: 'a' }),
    })
    expect(bad.status).toBe(400)
    const missing = await app.request('/admin/licenses/nope', {
      method: 'PATCH',
      headers: { ...json, ...auth },
      body: JSON.stringify({ expiresInDays: 1 }),
    })
    expect(missing.status).toBe(404)
  })

  it('列表接口按 product/app 过滤，且不回显 licenseKey 原文与私钥', async () => {
    const { app, auth } = setup()
    await app.request('/admin/products/tpl', {
      method: 'PUT',
      headers: { ...json, ...auth },
      body: JSON.stringify({ name: 't', allowSelfRegister: true }),
    })
    await app.request('/admin/licenses', {
      method: 'POST',
      headers: { ...json, ...auth },
      body: JSON.stringify({ productId: 'tpl', appId: 'a', licenseKey: 'SECRET-KEY' }),
    })
    const res = await app.request('/admin/licenses?productId=tpl', { headers: auth })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).not.toContain('SECRET-KEY')
    expect(text).toContain('instanceBound')
  })
})
