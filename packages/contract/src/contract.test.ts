import { describe, expect, it } from 'vitest'
import { canonicalize, isEntitlementExpired, type LicenseEntitlement } from './contract.ts'

/**
 * 本文件只测**不依赖签发器**的契约纯函数：canonicalize 与 isEntitlementExpired。
 *
 * Ed25519 签发/验签的 round-trip 与 keyIdOf/normalizePem 测试在
 * `apps/server/src/sign.test.ts`——它们需要 `sign.ts`（中心专属签发侧，持私钥），
 * 而 sign.ts 绝不能进本契约包：契约包会被 App 侧打进 bundle，签发能力只能留在中心。
 */

function ent(overrides: Partial<LicenseEntitlement> = {}): LicenseEntitlement {
  return {
    licenseId: 'lic-1',
    productId: 'tpl',
    appId: 'app-1',
    instanceKey: 'inst-1',
    status: 'active',
    expiresAt: null,
    enforcement: 'none',
    features: ['export'],
    notice: null,
    issuedAt: '2026-10-14T00:00:00.000Z',
    serverTime: '2026-10-14T00:00:00.000Z',
    heartbeatIntervalSec: 300,
    graceSec: 86400,
    ...overrides,
  }
}

describe('canonicalize — 签名的确定性基础', () => {
  it('键顺序无关，输出无空白', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }))
  })

  it('嵌套对象递归排序，数组保序', () => {
    expect(canonicalize({ z: { b: [3, 1, 2], a: 'x' } })).toBe('{"z":{"a":"x","b":[3,1,2]}}')
  })

  it('undefined 值被跳过：有无该键不能产生不同签名', () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe(canonicalize({ a: 1 }))
  })

  it('null / 布尔 / 中文与转义字符', () => {
    expect(canonicalize({ a: null, b: true, c: '到期' })).toBe('{"a":null,"b":true,"c":"到期"}')
  })

  it('对整个授权载荷稳定（同一对象多次序列化一致）', () => {
    const e = ent()
    expect(canonicalize(e)).toBe(canonicalize({ ...e }))
  })
})

describe('isEntitlementExpired — 消费侧本地判定（不等心跳）', () => {
  const NOW = Date.parse('2026-10-14T00:00:00.000Z')

  it('expiresAt=null → 永不过期', () => {
    expect(isEntitlementExpired(ent({ expiresAt: null }), NOW)).toBe(false)
  })

  it('未到期 / 恰好到期 / 已过期', () => {
    expect(isEntitlementExpired(ent({ expiresAt: '2026-10-15T00:00:00.000Z' }), NOW)).toBe(false)
    expect(isEntitlementExpired(ent({ expiresAt: '2026-10-14T00:00:00.000Z' }), NOW)).toBe(true)
    expect(isEntitlementExpired(ent({ expiresAt: '2026-10-13T00:00:00.000Z' }), NOW)).toBe(true)
  })

  it('serverTime 偏差校正：用户把系统时间往回调也判为过期', () => {
    // 本地时钟比中心慢 2 天（用户回拨），中心时间视角已过期
    const skewed = Date.parse('2026-10-16T00:00:00.000Z') - NOW
    expect(isEntitlementExpired(ent({ expiresAt: '2026-10-15T00:00:00.000Z' }), NOW, skewed)).toBe(
      true,
    )
  })

  it('非法日期字符串 → 不判过期（fail-open，避免格式问题误杀正常授权）', () => {
    expect(isEntitlementExpired(ent({ expiresAt: '不是日期' }), NOW)).toBe(false)
  })
})
