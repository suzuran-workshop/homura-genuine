import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * admin.ts 的「不泄漏 node:crypto」守卫。
 *
 * contract.ts 顶部 import 了 node:crypto（createHash/createPublicKey/verify）。web 管理台会
 * `import type {...} from '@homura-genuine/contract/admin'`；一旦 admin.ts 出现**运行值**的
 * 契约导入或 re-export（`export * from './contract'` / `export { GENUINE_ERROR_CODES } from ...`），
 * Vite 就会把 contract.ts 连同 node:crypto 拖进浏览器 bundle——而且只报 warning、构建照样成功，
 * 运行时才白屏。本测试把那条静默路径变成硬失败。
 *
 * 断言方式：直接扫源码文本。admin.ts 只允许 `import type ... from './contract.ts'`。
 */
const ADMIN = resolve(import.meta.dirname, './admin.ts')

/** 剥掉块注释与行注释——注释里提到这些词是在解释规则，不算泄漏 */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

describe('admin.ts 不得把 contract 的运行值泄漏给浏览器', () => {
  const src = stripComments(readFileSync(ADMIN, 'utf8'))

  it('对 contract 的 import 一律是 import type', () => {
    // 匹配所有 from './contract.ts' 的 import 语句
    const contractImports = src.match(/import\s+[^;]*from\s+['"]\.\/contract\.ts['"]/g) ?? []
    for (const stmt of contractImports) {
      expect(stmt, `发现非 type 的契约导入：${stmt}`).toMatch(/^import\s+type\b/)
    }
  })

  it('不含任何 re-export（export ... from）', () => {
    // `export * from` 或 `export { X } from` 都可能带出运行值
    const reexports = src.match(/export\s+(?:\*|\{[^}]*\})\s+from/g) ?? []
    expect(reexports, `admin.ts 出现 re-export：${reexports.join(', ')}`).toHaveLength(0)
  })

  it('源码里不出现 node:crypto 与契约的运行值符号', () => {
    for (const banned of [
      'node:crypto',
      'GENUINE_ERROR_CODES',
      'GENUINE_ENDPOINTS',
      'canonicalize',
    ]) {
      expect(src, `admin.ts 出现了不该有的运行值引用：${banned}`).not.toContain(banned)
    }
  })
})
