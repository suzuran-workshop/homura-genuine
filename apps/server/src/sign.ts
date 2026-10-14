/**
 * 签发侧密钥与签名（只在中心侧使用；验签在 contract.ts，两侧共用）。
 *
 * 密钥落库（signing_keys 表）而不是散在 env：轮换时新旧公钥要能同时对外可查，
 * 且 App 侧靠 keyId 选择用哪把公钥验签。私钥入库的代价是 DB 文件必须当作密钥保管
 * （.gitignore 已覆盖 data/ 与 *.pem；部署时该文件不应与其他 App 共盘）。
 */
import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto'
import {
  canonicalize,
  keyIdOf,
  type LicenseEntitlement,
  type SignedEntitlement,
} from '@homura-genuine/contract/contract'

export interface SigningKey {
  keyId: string
  /** Ed25519 公钥 PEM（SPKI），可公开分发 */
  publicKey: string
  /** Ed25519 私钥 PEM（PKCS#8），绝不外发 */
  privateKey: string
}

/** 生成一把新的 Ed25519 签名密钥 */
export function generateSigningKey(): SigningKey {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  return { keyId: keyIdOf(publicPem), publicKey: publicPem, privateKey: privatePem }
}

/** 对授权载荷签名：签名对象是 canonicalize(entitlement) 的 UTF-8 字节，输出 base64url */
export function signEntitlement(
  entitlement: LicenseEntitlement,
  privateKeyPem: string,
  keyId: string,
): SignedEntitlement {
  const data = Buffer.from(canonicalize(entitlement), 'utf8')
  const signature = sign(null, data, createPrivateKey(privateKeyPem)).toString('base64url')
  return { entitlement, signature, keyId }
}
