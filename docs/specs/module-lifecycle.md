# Spec — 生命周期与有效状态

## 要构建什么

- 目标：定义许可从签发到失效的完整生命周期——`register`（首次激活）、`heartbeat`（短周期
  刷新）、`adjustLicense`（运营随时调整）、`effectiveStatus`（有效状态计算）。
  以及消费侧的状态机优先级（中心下发状态 vs 本地判定 vs 验签结果）。

## 行为

### 有效状态计算（`effectiveStatus`）

**纯函数**，不存 DB（见 ADR-003）：

```
effectiveStatus(row, now):
  if row.manualStatus in ('suspended', 'revoked'): return 'suspended'
  if row.expiresAt !== null && row.expiresAt <= now: return 'expired'
  return 'active'
```

优先级：手动状态 > 到期 > 默认 active。

**注意**：中心从不下发 `grace` 或 `unknown`——那两个状态只存在于消费侧（心跳失联宽限 /
未注册 / 验签失败），是 App 侧对"网络问题"的处置，与"授权问题"严格分离。

### `register(input, now)` — 首次激活

输入：`{ productId, appId, instanceKey, licenseKey?, version?, fingerprint? }`

分支：

**A. 带 `licenseKey`（预签发模式）**：

1. 查 `licenses WHERE license_key = ?`
2. 不存在 → `404 license_not_found`
3. 存在但已绑别的 `instanceKey` → `403 instance_mismatch`（盗用信号）
4. 存在且未绑 → 绑当前 `instanceKey`
5. 存在且已绑同一个 → 幂等，直接返回

**B. 无 `licenseKey`（自助注册模式）**：

1. 查 `products WHERE id = ?`
2. 不存在 → `404 product_not_found`
3. `allow_self_register = false` → `403 self_register_disabled`
4. 否则新建 license：
   - `features` = product.defaultFeatures
   - `enforcement` = product.defaultEnforcement
   - `expiresAt` = `now + product.defaultTtlDays * 86400_000`（`defaultTtlDays = null` 则永不过期）
   - `manualStatus` = `active`
   - `instanceKey` = 输入值
   - `heartbeatIntervalSec` / `graceSec` = 全局默认（300 / 86400）

输出：`{ licenseId, status, heartbeatIntervalSec, graceSec, issuedAt, license: SignedEntitlement }`

`status` 是 `effectiveStatus(row, now)` 的结果。`SignedEntitlement` 由 `signEntitlement` 生成
（见 module-contract.md）。

### `heartbeat(input, now)` — 短周期刷新

输入：`{ licenseId, instanceKey, metrics?: { activeUsers?, reqPerMin? } }`

步骤：

1. 查 `licenses WHERE id = ?`
2. 不存在 → `404 license_not_found`
3. `instanceKey` 不符 → `403 instance_mismatch`
4. `UPDATE lastSeenAt = now`（`metrics` 目前只记日志，不入 DB）
5. 重新计算 `effectiveStatus(row, now)`——**可能已过期或被 PATCH 改过**
6. 重新构造 `LicenseEntitlement`（含最新字段 + `serverTime = now`）
7. 签名并返回

输出：`{ status, heartbeatIntervalSec, serverTime, notice?, license: SignedEntitlement }`

**关键**：心跳响应里的 `status` 与 `license.entitlement.status` 是**同一个值**（都是
`effectiveStatus` 的结果）。消费侧优先采信签名载荷里的值（因为可验签），标量 `status`
只是向后兼容。

### `adjustLicense(id, patch, now)` — 运营随时调整

输入：`{ expiresAt?, expiresInDays?, enforcement?, features?, notice?, status?, heartbeatIntervalSec?, graceSec? }`

语义：

- `undefined` = 不改
- `null` 有专门语义：
  - `expiresAt: null` = 永不过期
  - `notice: null` = 清空自定义文案（消费侧会走自动生成兜底）
- `expiresInDays: N` = 设 `expiresAt = now + N * 86400_000`（与 `expiresAt` 互斥，同时传时
  `expiresAt` 优先）
- `status: 'active' | 'suspended' | 'revoked'` = 改 `manualStatus`

**不存 `effectiveStatus`**（见 ADR-003）——下次读时算。

### `issueLicense(input, now)` — 预签发

输入：`{ productId, appId, licenseKey?, expiresAt?, expiresInDays?, enforcement?, features?, notice?, heartbeatIntervalSec?, graceSec? }`

与 `register` 的分支 A 类似，但**不绑 `instanceKey`**——等 App 首次 `register` 时再绑。
缺省字段从 product 的 defaults 取。

### 消费侧状态机优先级（参考，实现在 `../homura/packages/license/src/client.ts`）

`getStatus()` 从高到低：

1. 未注册 → `unknown`
2. 验签失败且策略为 `suspend` → `suspended`（见 ADR-013：invalid sig 触发最严处置）
3. 中心明示 `suspended` → `suspended`
4. **本地判定已到期** → `expired`（不等心跳；用 `serverTime` 偏差校正）
5. 失联超 `graceSec` → `grace`（fail-open，网络问题不拦）
6. 否则用中心下发的状态

**核心不变量**：验签不通过时，载荷里的任何字段都不得用于决策。否则篡改者可以把
`enforcement` 写成 `none`、把 `features` 塞满，等于绕过整个授权。

## 输入 / 输出

见上各函数签名。所有函数都接受 `now: number` 参数（缺省 `Date.now()`），返回
`ServiceResult<T> = { ok: true; value: T } | { ok: false; error: GenuineErrorBody; status: number }`。

## 约束

- **时间参数化注入**（见 ADR-012）：所有业务函数接受 `now` 参数，测试不依赖真实时钟、不 sleep
- **有效状态不存 DB**（见 ADR-003）：每次读时算
- **中心不下发 `grace`/`unknown`**：那两个状态只存在于消费侧
- **心跳响应必须重新签名**：即使字段没变，`serverTime` 也变了，签名必须刷新
- **`instanceKey` 绑定后不可改**：要换实例必须走"运营手动解绑 + App 重新注册"流程
  （当前未实现解绑端点，需要时加 `DELETE /admin/licenses/:id/instance`）

## 边界条件

- **`register` 幂等**：同一 `(product, app, instanceKey)` 重复注册返回同一 license，不新建
- **`heartbeat` 对已过期许可**：仍返 200，但 `status: expired`——消费侧需要知道"中心还活着，
  只是许可过期了"，与"中心失联"区分
- **`heartbeat` 对 suspended 许可**：仍返 200，`status: suspended`
- **`adjustLicense` 把 `expiresAt` 改到过去**：下次心跳消费侧立即看到 `expired`；且消费侧
  本地判定也会立即生效（不等心跳，见 ADR-004）
- **`adjustLicense` 把 `status` 从 suspended 改回 active**：下次心跳消费侧恢复 active
- **`adjustLicense` 把 `heartbeatIntervalSec` 改小**：消费侧下次心跳收到新值后立即按新间隔
  跑（端到端联调 2026-10-14 实测：300s → 10s 生效）
- **时钟回拨**：消费侧用 `serverTime` 校正本地时钟，回拨系统时间无效
- **`serverTime` 本身被篡改**：不可能——它在签名覆盖范围内（见 ADR-002）

## 验收标准

- [x] `effectiveStatus` 优先级：手动 > 到期 > active
- [x] `register` 分支 A：licenseKey 不存在 → 404；已绑别的 instanceKey → 403 instance_mismatch
- [x] `register` 分支 B：product 不存在 → 404；allow_self_register=false → 403 self_register_disabled
- [x] `register` 幂等：同 (product, app, instanceKey) 重复注册返回同一 license
- [x] `heartbeat`：license 不存在 → 404；instanceKey 不符 → 403
- [x] `heartbeat` 刷新 lastSeenAt 并重新签名（即使字段没变）
- [x] `adjustLicense`：undefined 不改；null 有专门语义；expiresInDays 与 expiresAt 互斥
- [x] 到期本地判定：消费侧 `expiresAt <= correctedNow` → 立即 expired，不等心跳
- [x] 时钟回拨防护：消费侧用 serverTime 校正，回拨无效
- [x] 心跳间隔调整：PATCH heartbeatIntervalSec 后消费侧下次心跳即按新间隔跑
      （2026-10-14 Pages 端到端实测通过）

## 完成定义

- 如何判定已完成：`service.test.ts` 全绿（22 项），且消费侧 `../homura/packages/license`
  的对应测试全绿。端到端联调（standalone 八阶段 + Pages 五场景）通过。
