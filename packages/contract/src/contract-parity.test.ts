import { readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 契约逐字同步门禁。
 *
 * src/contract.ts 与 ../homura/packages/license/src/contract.ts 必须**字节一致**：
 * 里面的 canonicalize 决定签名字节、verifyEntitlement 决定验签判定，两侧不一致会导致
 * 「中心签得出来、App 验不过」或更糟的「验签形同虚设」——而且这类失败是静默的。
 *
 * ⚠ 本文件从 src/ 迁到了 packages/contract/src/（深两级），相对路径层级随之变化。
 *   层级算错的后果不是「测试红」而是「测试静默跳过、门禁形同虚设」，故此处刻意做两级判定：
 *   - 对端**仓库**不在（如 CI 只检出本仓库）→ 合理跳过
 *   - 对端仓库在、但契约**文件**不在预期路径 → 说明本文件的相对层级算错了 → **显式失败**
 *
 * 改契约的正确姿势：改一侧 → cp 到另一侧 → 跑本测试 → 两侧各写 ADR/spec 留痕。
 */
const SELF = resolve(import.meta.dirname, './contract.ts')
// packages/contract/src → 退三级 = homura-genuine 仓库根
const REPO_ROOT = resolve(import.meta.dirname, '../../..')
const PEER_REPO = resolve(REPO_ROOT, '../homura')
const PEER = resolve(PEER_REPO, 'packages/license/src/contract.ts')
const peerRepoPresent = existsSync(join(PEER_REPO, 'package.json'))

describe('契约逐字同步（../homura/packages/license/src/contract.ts）', () => {
  it('本侧契约文件存在且非空（防止 contract.ts 被移走后本文件空转）', () => {
    expect(existsSync(SELF), `本侧契约文件不在预期路径：${SELF}`).toBe(true)
    expect(readFileSync(SELF, 'utf8').length).toBeGreaterThan(0)
  })

  it.skipIf(!peerRepoPresent)('两份 contract.ts 字节一致', () => {
    if (!existsSync(PEER)) {
      throw new Error(
        `对端仓库存在（${PEER_REPO}）但契约文件不在预期路径：${PEER}\n` +
          '  多半是本文件的 PEER 相对层级算错了（packages/contract/src 下应退三级到仓库根，再 ../homura），' +
          '  或对端重构了目录结构。',
      )
    }
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
    const mod = await import('./contract.ts')
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
