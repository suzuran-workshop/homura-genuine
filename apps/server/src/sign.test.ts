import { describe, expect, it } from 'vitest'
import { keyIdOf, normalizePem, verifyEntitlement, type LicenseEntitlement } from '@homura-genuine/contract/contract'
import { generateSigningKey, signEntitlement } from './sign.ts'

/**
 * Ed25519 签发/验签 round-trip：sign.ts（中心专属签发侧）与 contract.ts（两侧共用验签侧）的集成测试。
 *
 * 为什么放 server 侧而不是契约包：这些用例都要先 `generateSigningKey()` 造私钥再签——
 * 签发能力只存在于中心，契约包被 App 侧打进 bundle，绝不能携带 sign.ts。
 * （纯函数 canonicalize / isEntitlementExpired 的测试留在 packages/contract/src/contract.test.ts。）
 */

const KEY = generateSigningKey()

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

describe('Ed25519 签发与验签', () => {
  it('round-trip 通过', () => {
    const signed = signEntitlement(ent(), KEY.privateKey, KEY.keyId)
    expect(verifyEntitlement(signed, KEY.publicKey)).toEqual({ ok: true })
  })

  it('篡改 features（给自己加功能）→ 验签失败', () => {
    const signed = signEntitlement(ent({ features: ['basic'] }), KEY.privateKey, KEY.keyId)
    const tampered = {
      ...signed,
      entitlement: { ...signed.entitlement, features: ['basic', 'export', 'admin'] },
    }
    expect(verifyEntitlement(tampered, KEY.publicKey).ok).toBe(false)
  })

  it('篡改 expiresAt（把到期日改晚）→ 验签失败', () => {
    const signed = signEntitlement(
      ent({ expiresAt: '2026-01-01T00:00:00.000Z' }),
      KEY.privateKey,
      KEY.keyId,
    )
    const tampered = {
      ...signed,
      entitlement: { ...signed.entitlement, expiresAt: '2099-01-01T00:00:00.000Z' },
    }
    const r = verifyEntitlement(tampered, KEY.publicKey)
    expect(r.ok).toBe(false)
  })

  it('篡改 status（expired → active）与 enforcement（all → none）→ 验签失败', () => {
    const signed = signEntitlement(
      ent({ status: 'expired', enforcement: 'all' }),
      KEY.privateKey,
      KEY.keyId,
    )
    expect(
      verifyEntitlement(
        { ...signed, entitlement: { ...signed.entitlement, status: 'active' } },
        KEY.publicKey,
      ).ok,
    ).toBe(false)
    expect(
      verifyEntitlement(
        { ...signed, entitlement: { ...signed.entitlement, enforcement: 'none' } },
        KEY.publicKey,
      ).ok,
    ).toBe(false)
  })

  it('篡改 instanceKey（把授权挪到别的实例）→ 验签失败', () => {
    const signed = signEntitlement(ent(), KEY.privateKey, KEY.keyId)
    const tampered = {
      ...signed,
      entitlement: { ...signed.entitlement, instanceKey: 'inst-other' },
    }
    expect(verifyEntitlement(tampered, KEY.publicKey).ok).toBe(false)
  })

  it('keyId 不匹配 → 失败原因指向密钥轮换，而不是笼统的"签名错"', () => {
    const other = generateSigningKey()
    const signed = signEntitlement(ent(), other.privateKey, other.keyId)
    const r = verifyEntitlement(signed, KEY.publicKey)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.reason).toMatch(/轮换/)
  })

  it('keyId 对但用错私钥签 → 失败原因指向篡改', () => {
    const other = generateSigningKey()
    const signed = signEntitlement(ent(), other.privateKey, KEY.keyId)
    const r = verifyEntitlement(signed, KEY.publicKey)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.reason).toMatch(/篡改|不符/)
  })

  it('签名是 base64url（可安全放进 JSON 与 URL）', () => {
    const signed = signEntitlement(ent(), KEY.privateKey, KEY.keyId)
    expect(signed.signature).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('keyIdOf 稳定、16 位 hex、不含密钥材料', () => {
    expect(keyIdOf(KEY.publicKey)).toBe(KEY.keyId)
    expect(KEY.keyId).toMatch(/^[0-9a-f]{16}$/)
    expect(KEY.publicKey).not.toContain(KEY.privateKey.slice(0, 40))
  })

  it('keyIdOf 对 PEM 空白不敏感（尾随换行 / CRLF / 首尾空格）', () => {
    // 手工从启动日志复制公钥时尾随换行会丢，若 keyId 对此敏感就会伪装成「密钥轮换事故」
    const pem = KEY.publicKey
    expect(keyIdOf(pem.trim())).toBe(KEY.keyId)
    expect(keyIdOf(`${pem}\n`)).toBe(KEY.keyId)
    expect(keyIdOf(`  ${pem.replace(/\n/g, '\r\n')}  `)).toBe(KEY.keyId)
    expect(normalizePem('  a\r\nb  ')).toBe('a\nb')
  })

  it('验签不因公钥 PEM 的空白差异而失败', () => {
    const signed = signEntitlement(ent(), KEY.privateKey, keyIdOf(KEY.publicKey.trim()))
    expect(verifyEntitlement(signed, `${KEY.publicKey}\n`)).toEqual({ ok: true })
    expect(verifyEntitlement(signed, KEY.publicKey.trim())).toEqual({ ok: true })
  })
})
