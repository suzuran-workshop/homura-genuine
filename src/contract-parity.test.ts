import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 契约逐字同步门禁。
 *
 * src/contract.ts 与 ../homura/packages/license/src/contract.ts 必须**字节一致**：
 * 里面的 canonicalize 决定签名字节、verifyEntitlement 决定验签判定，两侧不一致会导致
 * 「中心签得出来、App 验不过」或更糟的「验签形同虚设」——而且这类失败是静默的。
 *
 * 对端仓库不在时跳过（例如 CI 只检出本仓库），但本地两仓库并存时必须过。
 * 改契约的正确姿势：改一侧 → cp 到另一侧 → 跑本测试 → 两侧各写 ADR/spec 留痕。
 */
const SELF = resolve(import.meta.dirname, './contract.ts')
const PEER = resolve(import.meta.dirname, '../../homura/packages/license/src/contract.ts')

describe('契约逐字同步（../homura/packages/license/src/contract.ts）', () => {
  it.skipIf(!existsSync(PEER))('两份 contract.ts 字节一致', () => {
    const self = readFileSync(SELF, 'utf8')
    const peer = readFileSync(PEER, 'utf8')
    if (peer !== self) {
      // 给出可行动的差异提示，而不是只说"不相等"
      const selfLines = self.split('\n')
      const peerLines = peer.split('\n')
      const firstDiff = selfLines.findIndex((line, i) => line !== peerLines[i])
      const at =
        firstDiff === -1
          ? `行数不同（本侧 ${selfLines.length} / 对端 ${peerLines.length}）`
          : `第 ${firstDiff + 1} 行起不同`
      throw new Error(
        `契约漂移：${at}\n` +
          `  本侧: ${SELF}\n  对端: ${PEER}\n` +
          '  修法：确定哪一侧是新版，然后 cp 覆盖另一侧（不要手工合并），再跑本测试。',
      )
    }
    expect(peer).toBe(self)
  })

  it('本侧契约导出面完整（防止误删导出导致对端编译失败）', async () => {
    const mod = await import('./contract.js')
    for (const name of [
      'GENUINE_API_VERSION',
      'GENUINE_ENDPOINTS',
      'GENUINE_ERROR_CODES',
      'canonicalize',
      'keyIdOf',
      'verifyEntitlement',
      'isEntitlementExpired',
    ]) {
      expect(mod, `缺少导出 ${name}`).toHaveProperty(name)
    }
  })
})
