import { describe, expect, it } from 'vitest'
import { verifyEntitlement } from './contract.js'
import { GenuineDb } from './db.js'
import { LicenseService } from './service.js'

const DAY = 86_400_000

function setup() {
  const db = new GenuineDb(':memory:')
  const service = new LicenseService(db)
  return { db, service }
}

function product(
  service: LicenseService,
  db: GenuineDb,
  overrides: Partial<{
    defaultFeatures: string[]
    defaultTtlDays: number | null
    allowSelfRegister: boolean
    defaultEnforcement: 'none' | 'notice' | 'core' | 'all'
  }> = {},
) {
  db.upsertProduct({
    id: 'tpl',
    name: '模板产品',
    defaultFeatures: ['basic'],
    defaultEnforcement: 'all',
    defaultTtlDays: 30,
    allowSelfRegister: false,
    ...overrides,
  })
  return service
}

describe('register — 签发与实例绑定', () => {
  it('产品不存在 → 404 product_not_found', () => {
    const { service } = setup()
    const r = service.register({ productId: 'nope', appId: 'a', instanceKey: 'i' })
    expect(r).toMatchObject({ ok: false, status: 404, error: 'product_not_found' })
  })

  it('缺必填字段 → 400', () => {
    const { service } = setup()
    expect(service.register({ productId: '', appId: 'a', instanceKey: 'i' })).toMatchObject({
      ok: false,
      status: 400,
    })
  })

  it('未开自助注册 → 403 self_register_disabled（中心保留签发权）', () => {
    const { service, db } = setup()
    product(service, db)
    const r = service.register({ productId: 'tpl', appId: 'app-1', instanceKey: 'i1' })
    expect(r).toMatchObject({ ok: false, status: 403, error: 'self_register_disabled' })
  })

  it('开了自助注册 → 用产品默认值签发（TTL/功能范围/处置强度）', () => {
    const { service, db } = setup()
    product(service, db, {
      allowSelfRegister: true,
      defaultFeatures: ['basic', 'export'],
      defaultTtlDays: 7,
    })
    const now = Date.now()
    const r = service.register({ productId: 'tpl', appId: 'app-1', instanceKey: 'i1' }, now)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.status).toBe('active')
    expect(r.value.license.entitlement.features).toEqual(['basic', 'export'])
    expect(Date.parse(r.value.license.entitlement.expiresAt!)).toBe(now + 7 * DAY)
    expect(r.value.license.entitlement.instanceKey).toBe('i1')
  })

  it('同一实例重复注册幂等（拿回同一张许可）', () => {
    const { service, db } = setup()
    product(service, db, { allowSelfRegister: true })
    const a = service.register({ productId: 'tpl', appId: 'app-1', instanceKey: 'i1' })
    const b = service.register({ productId: 'tpl', appId: 'app-1', instanceKey: 'i1' })
    expect(a.ok && b.ok && a.value.licenseId === b.value.licenseId).toBe(true)
  })

  it('预签发许可被换个实例复用 → 403 instance_mismatch（授权被复制的盗用信号）', () => {
    const { service, db } = setup()
    product(service, db)
    const issued = service.issueLicense({ productId: 'tpl', appId: 'app-1', licenseKey: 'KEY-1' })
    expect(issued.ok).toBe(true)
    const first = service.register({
      productId: 'tpl',
      appId: 'app-1',
      instanceKey: 'i1',
      licenseKey: 'KEY-1',
    })
    expect(first.ok).toBe(true)
    // 同一把 key 从另一个实例来注册 → 拒（而不是给它新签一张）
    const second = service.register({
      productId: 'tpl',
      appId: 'app-1',
      instanceKey: 'i2',
      licenseKey: 'KEY-1',
    })
    expect(second).toMatchObject({ ok: false, status: 403, error: 'instance_mismatch' })
  })

  it('自助注册产品**不做实例管控**：每个 instanceKey 各签一张（这是 allowSelfRegister 的定义，需要管控就别开它）', () => {
    const { service, db } = setup()
    product(service, db, { allowSelfRegister: true })
    const a = service.register({ productId: 'tpl', appId: 'app-1', instanceKey: 'i1' })
    const b = service.register({ productId: 'tpl', appId: 'app-1', instanceKey: 'i2' })
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(a.value.licenseId).not.toBe(b.value.licenseId)
    expect(db.listLicenses({ productId: 'tpl' })).toHaveLength(2)
  })

  it('用 licenseKey 注册：签发时不绑实例，注册时绑定', () => {
    const { service, db } = setup()
    product(service, db)
    const issued = service.issueLicense({ productId: 'tpl', appId: 'app-1', licenseKey: 'KEY-1' })
    expect(issued.ok).toBe(true)
    const r = service.register({
      productId: 'tpl',
      appId: 'app-1',
      instanceKey: 'i9',
      licenseKey: 'KEY-1',
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.license.entitlement.instanceKey).toBe('i9')
  })
})

describe('到期与处置（需求 1：中心设期限、可随时调整；消费侧发现过期即处置 + 强提醒）', () => {
  it('已过期 → status=expired，自动生成含到期日的强提醒文案，enforcement 用许可配置', () => {
    const { service, db } = setup()
    product(service, db, { defaultEnforcement: 'core' })
    const issued = service.issueLicense({ productId: 'tpl', appId: 'a', expiresInDays: -1 })
    expect(issued.ok).toBe(true)
    if (!issued.ok) return
    const ent = service.entitlementFor(issued.value)
    expect(ent.status).toBe('expired')
    expect(ent.enforcement).toBe('core')
    expect(ent.notice).toMatch(/到期/)
    expect(ent.notice).toMatch(/供应方/)
  })

  it('中心自定义的 notice 优先于自动生成', () => {
    const { service, db } = setup()
    product(service, db)
    const issued = service.issueLicense({
      productId: 'tpl',
      appId: 'a',
      expiresInDays: -1,
      notice: '请联系张三续期：zhangsan@example.com',
    })
    if (!issued.ok) throw new Error('unreachable')
    expect(service.entitlementFor(issued.value).notice).toContain('zhangsan@example.com')
  })

  it('期限随时可调：延长后立即回到 active（下一次心跳即生效）', () => {
    const { service, db } = setup()
    product(service, db)
    const issued = service.issueLicense({ productId: 'tpl', appId: 'a', expiresInDays: -1 })
    if (!issued.ok) throw new Error('unreachable')
    expect(service.effectiveStatus(issued.value)).toBe('expired')

    const adjusted = service.adjustLicense(issued.value.licenseId, { expiresInDays: 30 })
    expect(adjusted.ok).toBe(true)
    if (!adjusted.ok) return
    expect(service.effectiveStatus(adjusted.value)).toBe('active')
    expect(service.entitlementFor(adjusted.value).notice).toBeNull()
    expect(service.entitlementFor(adjusted.value).enforcement).toBe('none')
  })

  it('处置强度可随时调（all → notice → core）', () => {
    const { service, db } = setup()
    product(service, db)
    const issued = service.issueLicense({ productId: 'tpl', appId: 'a', expiresInDays: -1 })
    if (!issued.ok) throw new Error('unreachable')
    for (const enforcement of ['notice', 'core', 'all'] as const) {
      const r = service.adjustLicense(issued.value.licenseId, { enforcement })
      if (!r.ok) throw new Error('unreachable')
      expect(service.entitlementFor(r.value).enforcement).toBe(enforcement)
    }
  })

  it('功能范围可随时调（需求 2：不同许可证开放不同能力）', () => {
    const { service, db } = setup()
    product(service, db)
    const issued = service.issueLicense({ productId: 'tpl', appId: 'a', features: ['basic'] })
    if (!issued.ok) throw new Error('unreachable')
    expect(service.entitlementFor(issued.value).features).toEqual(['basic'])
    const r = service.adjustLicense(issued.value.licenseId, { features: ['basic', 'export', 'ai'] })
    if (!r.ok) throw new Error('unreachable')
    expect(service.entitlementFor(r.value).features).toEqual(['basic', 'export', 'ai'])
  })

  it('手动 suspended 优先于到期判定，且 revoked 也映射为 suspended', () => {
    const { service, db } = setup()
    product(service, db)
    const issued = service.issueLicense({ productId: 'tpl', appId: 'a', expiresInDays: 10 })
    if (!issued.ok) throw new Error('unreachable')
    const s = service.adjustLicense(issued.value.licenseId, { status: 'suspended' })
    if (!s.ok) throw new Error('unreachable')
    expect(service.effectiveStatus(s.value)).toBe('suspended')
    const rv = service.adjustLicense(issued.value.licenseId, { status: 'revoked' })
    if (!rv.ok) throw new Error('unreachable')
    expect(service.effectiveStatus(rv.value)).toBe('suspended')
  })

  it('active 时 enforcement 恒为 none（不给消费侧留误拦的余地）', () => {
    const { service, db } = setup()
    product(service, db, { defaultEnforcement: 'all' })
    const issued = service.issueLicense({ productId: 'tpl', appId: 'a', expiresInDays: 10 })
    if (!issued.ok) throw new Error('unreachable')
    expect(service.entitlementFor(issued.value).enforcement).toBe('none')
  })
})

describe('heartbeat', () => {
  it('licenseId 不存在 → 404；instanceKey 不符 → 403', () => {
    const { service, db } = setup()
    product(service, db, { allowSelfRegister: true })
    service.register({ productId: 'tpl', appId: 'a', instanceKey: 'i1' })
    expect(service.heartbeat({ licenseId: 'nope', instanceKey: 'i1' })).toMatchObject({
      ok: false,
      status: 404,
    })
    const reg = service.register({ productId: 'tpl', appId: 'a', instanceKey: 'i1' })
    if (!reg.ok) throw new Error('unreachable')
    expect(
      service.heartbeat({ licenseId: reg.value.licenseId, instanceKey: 'other' }),
    ).toMatchObject({
      ok: false,
      status: 403,
      error: 'instance_mismatch',
    })
  })

  it('成功心跳返回签名授权，并刷新 lastSeenAt', () => {
    const { service, db } = setup()
    product(service, db, { allowSelfRegister: true })
    const reg = service.register({ productId: 'tpl', appId: 'a', instanceKey: 'i1' })
    if (!reg.ok) throw new Error('unreachable')
    const before = db.getLicense(reg.value.licenseId)?.lastSeenAt ?? null
    const hb = service.heartbeat(
      { licenseId: reg.value.licenseId, instanceKey: 'i1' },
      Date.now() + 5000,
    )
    expect(hb.ok).toBe(true)
    if (!hb.ok) return
    expect(hb.value.status).toBe('active')
    expect(hb.value.license.entitlement.licenseId).toBe(reg.value.licenseId)
    const after = db.getLicense(reg.value.licenseId)?.lastSeenAt ?? null
    expect(after).not.toBe(before)
  })

  it('下发的授权可用中心公钥验签（消费侧的信任根）', () => {
    const { service, db } = setup()
    product(service, db, { allowSelfRegister: true })
    const reg = service.register({ productId: 'tpl', appId: 'a', instanceKey: 'i1' })
    if (!reg.ok) throw new Error('unreachable')
    const key = service.activeKey()
    expect(key).not.toBeNull()
    expect(verifyEntitlement(reg.value.license, key!.publicPem)).toEqual({ ok: true })
  })

  it('到期后的心跳直接下发 expired + notice（消费侧无需自己算也能处置）', () => {
    const { service, db } = setup()
    product(service, db)
    const issued = service.issueLicense({
      productId: 'tpl',
      appId: 'a',
      expiresInDays: -1,
      licenseKey: 'K',
    })
    if (!issued.ok) throw new Error('unreachable')
    service.register({ productId: 'tpl', appId: 'a', instanceKey: 'i1', licenseKey: 'K' })
    const hb = service.heartbeat({ licenseId: issued.value.licenseId, instanceKey: 'i1' })
    expect(hb.ok).toBe(true)
    if (!hb.ok) return
    expect(hb.value.status).toBe('expired')
    expect(hb.value.notice).toMatch(/到期/)
  })
})

describe('签名密钥', () => {
  it('首次构造自动生成，重复构造沿用同一把', () => {
    const db = new GenuineDb(':memory:')
    const a = new LicenseService(db)
    const b = new LicenseService(db)
    expect(a.activeKey()?.keyId).toBe(b.activeKey()?.keyId)
  })

  it('轮换后旧钥退休、新钥成为签发用，且旧签名仍能用旧公钥验', () => {
    const { service, db } = setup()
    product(service, db, { allowSelfRegister: true })
    const oldKey = service.activeKey()!
    const reg = service.register({ productId: 'tpl', appId: 'a', instanceKey: 'i1' })
    if (!reg.ok) throw new Error('unreachable')

    db.retireSigningKey(oldKey.keyId)
    const newKey = service.ensureSigningKey()
    expect(newKey.created).toBe(true)
    expect(newKey.keyId).not.toBe(oldKey.keyId)

    // 历史签名用旧公钥仍可验（轮换不该让存量 App 立刻失效）
    expect(verifyEntitlement(reg.value.license, oldKey.publicPem)).toEqual({ ok: true })
    // 新签发的用新钥
    const hb = service.heartbeat({ licenseId: reg.value.licenseId, instanceKey: 'i1' })
    if (!hb.ok) throw new Error('unreachable')
    expect(hb.value.license.keyId).toBe(newKey.keyId)
  })
})
