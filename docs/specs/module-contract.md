# Spec — contract 与签名

## 要构建什么

- 目标：定义中心与消费侧之间**跨仓库共享**的契约层——状态与处置强度枚举、授权载荷类型、
  端点常量、错误码、确定性序列化（`canonicalize`）、PEM 归一（`normalizePem`）、keyId
  派生（`keyIdOf`）、验签（`verifyEntitlement`）、本地到期判定（`isEntitlementExpired`）。
  以及中心侧专用的签发（`signEntitlement`，在 `sign.ts`）。

## 行为

### 授权载荷 `LicenseEntitlement`

| 字段 | 类型 | 含义 | 为什么必须在签名覆盖范围内 |
| ---- | ---- | ---- | -------------------------- |
| `licenseId` | string | 许可唯一 ID | 标识 |
| `productId` | string | 产品 ID | 防跨产品挪用 |
| `appId` | string | App ID | 防跨 App 挪用 |
| `instanceKey` | string | 绑定的实例 | **防把 A 实例的授权响应重放给 B 实例** |
| `status` | `active\|expired\|suspended` | 有效状态 | 防把 expired/suspended 改成 active |
| `expiresAt` | string \| null | ISO 到期时间（null = 永不过期） | **防把到期日改晚** |
| `enforcement` | `none\|notice\|core\|all` | 处置强度 | 防篡改者自选最宽处置 |
| `features` | string[] | 授权的功能范围 | 防自己给自己加功能 |
| `notice` | string \| null | 强提醒文案 | 防把提醒文案抹掉 |
| `issuedAt` | string | 签发时间（ISO） | 审计 |
| `serverTime` | string | 中心当前时间（ISO） | **供消费侧校正本地时钟偏差，防回拨系统时间绕过到期** |
| `heartbeatIntervalSec` | number | 心跳间隔 | 防把心跳周期改长（延迟处置生效） |
| `graceSec` | number | 失联宽限期 | 防把宽限期改长 |

### `canonicalize(value)`

确定性 JSON 序列化，规则：

- 对象键**升序**排列
- `undefined` 值**跳过**（不出现在输出里）
- 数组**保序**（不排序）
- 无空白（紧凑输出）
- 嵌套递归应用同规则
- 字符串用 `JSON.stringify` 转义

**为什么必须是契约的一部分**：签名字节 = `Ed25519.sign(utf8(canonicalize(entitlement)), privateKey)`。
两侧 canonicalize 差一个字节，签名就对不上——但**不会报错**，只会让 App 永远进入 `invalid`
状态。这就是为什么 `canonicalize` 放在 contract.ts 而不是各自的工具文件。

### `normalizePem(pem)`

PEM 归一化：`CRLF → LF` + `trim()`。**为什么必须是契约的一部分**：`keyId = sha256(normalizePem(publicPem))[:16]`。
两侧 normalizePem 不一致，keyId 就对不上——App 会报"keyId 不匹配"但公钥其实是同一把。

### `keyIdOf(publicKeyPem)`

`sha256(normalizePem(pem))` 的前 16 位 hex。**为什么是 16 位**：足够唯一（碰撞概率可忽略），
又短到能塞进日志与错误信息。

### `verifyEntitlement(signed, publicKeyPem)`

消费侧验签入口，返回 `{ ok: true } | { ok: false; reason: string }`。步骤：

1. `keyIdOf(publicKeyPem)` 与 `signed.keyId` 比对——不符直接返回 `{ ok: false, reason: 'keyId 不匹配...' }`
2. `Ed25519.verify(utf8(canonicalize(signed.entitlement)), base64urlDecode(signed.signature), publicKey)`
3. 验签失败 → `{ ok: false, reason: '签名验证失败' }`

**注意**：验签只保证"载荷没被篡改、且是中心签的"。**不保证**载荷里的 `instanceKey` 与
本地一致——那是消费侧 `LicenseClient` 的额外校验（`invalid` 状态的 reason 之一就是
"授权属于别的实例"）。

### `isEntitlementExpired(entitlement, now)`

本地到期判定：`entitlement.expiresAt !== null && Date.parse(entitlement.expiresAt) <= now`。
**为什么在 contract.ts**：中心与消费侧都要用同一份判定逻辑——中心算 `effectiveStatus`
用它，消费侧本地判定也用它。两侧不一致会出现"中心说 active，消费侧说 expired"的矛盾。

### `signEntitlement(entitlement, privatePem)`（中心侧，在 `sign.ts`）

返回 `SignedEntitlement`：`{ entitlement, signature: base64url(Ed25519.sign(...)), keyId }`。
`keyId` 由对应公钥派生（`keyIdOf(publicPem)`）。

## 输入 / 输出

**输入**：见上表各函数签名。

**输出**：

- `canonicalize` → string（确定性 JSON）
- `normalizePem` → string（LF 换行、无前后空白的 PEM）
- `keyIdOf` → string（16 位 hex）
- `verifyEntitlement` → `{ ok: true } | { ok: false; reason: string }`
- `isEntitlementExpired` → boolean
- `signEntitlement` → `SignedEntitlement`

## 约束

- **`contract.ts` 只允许依赖 Node 内置**（`node:crypto`）。会被 App 侧打进 bundle，引第三方
  等于给所有派生 App 加依赖（见 ADR-011）
- **`contract.ts` 与 `../homura/packages/license/src/contract.ts` 必须逐字一致**——含
  `canonicalize` / `normalizePem` / `verifyEntitlement`。由 `contract-parity.test.ts` 守门
  （见 ADR-008）
- 加字段 = 改契约 = 同步两侧 + 走 parity 测试 + 两侧各写 ADR/spec 留痕
- `canonicalize` 的规则不能改——改了等于让所有历史签名失效

## 边界条件

- **空对象/空数组**：`canonicalize({})` = `"{}"`，`canonicalize([])` = `"[]"`
- **嵌套 undefined**：`canonicalize({ a: undefined, b: { c: undefined, d: 1 } })` =
  `'{"b":{"d":1}}'`（undefined 全跳过）
- **数组保序**：`canonicalize({ a: [3, 1, 2] })` = `'{"a":[3,1,2]}'`（**不**排序）
- **字符串转义**：走 `JSON.stringify`，Unicode/引号/反斜杠都正确转义
- **PEM 带 BOM 或多余空白**：`normalizePem` 会 trim 掉，但 BOM 需要调用方先处理
- **keyId 碰撞**：16 位 hex = 64 bit，碰撞概率可忽略；真碰撞时验签会失败（因为公钥不同）
- **验签时公钥格式错**：`Ed25519.verify` 会抛异常，`verifyEntitlement` 应捕获并返回
  `{ ok: false, reason: '公钥格式错误' }`

## 验收标准

- [x] `canonicalize` 确定性：同输入多次调用输出字节一致；键序无关
- [x] `canonicalize` 跳过 undefined、数组保序、无空白
- [x] `normalizePem` CRLF → LF + trim
- [x] `keyIdOf` = sha256(normalizePem(pem))[:16]
- [x] `signEntitlement` + `verifyEntitlement` 往返通过
- [x] 篡改载荷任何字段 → 验签失败
- [x] 换公钥 → 验签失败（keyId 不匹配）
- [x] `isEntitlementExpired` 在 `expiresAt = null` 时恒 false
- [x] `isEntitlementExpired` 在边界（`expiresAt === now`）判定为已过期（`<=`）
- [x] `contract-parity.test.ts` 逐字比对两侧文件，漂移时报首个不同行号

## 完成定义

- 如何判定已完成：`pnpm test` 全绿，且 `contract-parity.test.ts` 通过。任何契约改动都必须
  同步两侧文件并两侧各自跑测试通过。
