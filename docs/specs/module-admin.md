# Spec — 管理端点

## 要构建什么

- 目标：定义中心运营方通过 HTTP 管理产品、许可、签名密钥的端点集合。所有管理端点走
  Bearer token 鉴权（`GENUINE_ADMIN_TOKEN`），未配 token 时整体 503。

## 行为

### 鉴权中间件

```
admin.use('*', async (c, next) => {
  if (!adminToken) return 503 { error: 'admin_disabled', message: '未配置 GENUINE_ADMIN_TOKEN' }
  const auth = c.req.header('authorization')
  if (!auth?.startsWith('Bearer ')) return 401 { error: 'unauthorized' }
  const token = auth.slice(7)
  if (!timingSafeEqual(token, adminToken)) return 401 { error: 'unauthorized' }
  await next()
})
```

**关键点**：

- 未配 token → **503**（不是 404，让运营看到"你没配 token"而不是"接口坏了"）
- Bearer token 用 `timingSafeEqual` 比对（防时序攻击）
- 长度不等时 `timingSafeEqual` 会抛异常，需先比长度

### `PUT /admin/products/:id` — 建/改产品

请求体：

```json
{
  "name": "Pro",
  "defaultFeatures": ["basic", "export"],
  "defaultEnforcement": "core",
  "defaultTtlDays": 30,
  "allowSelfRegister": true
}
```

语义：upsert——存在则更新，不存在则创建。`id` 从路径取。

响应：`{ product: AdminProduct }`

**注意**：请求体里 `allowSelfRegister` 按 `=== true` 严格判定（传 `"true"`/`1` 会被当成 false）；
`defaultTtlDays` 非数字则记为 `null`（永不过期）。响应经 `service.describeProduct` 转成**对外干净形状**：
`allowSelfRegister` 是真 `boolean`（库里存 0/1，`node:sqlite` 不接受 boolean 绑定）、`defaultFeatures`
是 `string[]`（库里存 JSON 文本，读时 `safeJsonArray` 解析）、`createdAt` 是 ISO-8601 字符串。
存储层的 0/1 与 JSON 文本怪味关在后端，管理台不必关心（见 ADR / `packages/contract/src/admin.ts` 的 `AdminProduct`）。

### `GET /admin/products` — 产品列表

响应：`{ products: AdminProduct[] }`（同上，经 `describeProduct` 转换）

### `POST /admin/licenses` — 预签发许可

请求体：

```json
{
  "productId": "pro",
  "appId": "app-1",
  "licenseKey": "LIC-1",
  "expiresInDays": 365,
  "enforcement": "core",
  "features": ["basic", "export"],
  "notice": "试用剩余 3 天",
  "heartbeatIntervalSec": 60,
  "graceSec": 3600
}
```

语义：

- `productId` / `appId` 必填
- `licenseKey` 可选——不传则 App 侧只能走自助注册（如果产品允许）
- `expiresInDays` 与 `expiresAt` 互斥，同时传时 `expiresAt` 优先
- `enforcement` / `features` / `notice` 缺省从 product 的 defaults 取
- `heartbeatIntervalSec` / `graceSec` 缺省用全局默认（300 / 86400）
- **不绑 `instanceKey`**——等 App 首次 `register` 时再绑

响应：`201 { license: LicenseDescribe }`

`LicenseDescribe` 是 `service.describe(row)` 的输出，含 `effectiveStatus` / `expired` 计算字段，
**不回显 `licenseKey` 原文与私钥**。

### `GET /admin/licenses?productId=&appId=` — 许可列表

查询参数都可选，用于过滤。

响应：`{ licenses: LicenseDescribe[] }`

### `GET /admin/licenses/:id` — 单个许可

响应：`{ license: LicenseDescribe }` 或 `404 license_not_found`

### `PATCH /admin/licenses/:id` — 随时调整

请求体（所有字段可选）：

```json
{
  "expiresAt": "2026-12-31T23:59:59.999Z",
  "expiresInDays": 90,
  "enforcement": "all",
  "features": ["basic", "export", "ai"],
  "notice": "许可已停，请联系供应方",
  "status": "suspended",
  "heartbeatIntervalSec": 10,
  "graceSec": 120
}
```

语义见 module-lifecycle.md 的 `adjustLicense`。**不存 `effectiveStatus`**——下次读时算。

响应：`{ license: LicenseDescribe }`

**典型运营动作**：

```bash
T=$GENUINE_ADMIN_TOKEN
H='-H "authorization: Bearer $T" -H "content-type: application/json"'

# 延期 90 天
curl -X PATCH localhost:8787/admin/licenses/<id> $H -d '{"expiresInDays":90}'

# 改成永不过期
curl -X PATCH localhost:8787/admin/licenses/<id> $H -d '{"expiresAt":null}'

# 加功能
curl -X PATCH localhost:8787/admin/licenses/<id> $H -d '{"features":["basic","export","ai"]}'

# 改处置强度（注意：status=active 时 enforcement 恒为 none，见 ADR-005）
curl -X PATCH localhost:8787/admin/licenses/<id> $H -d '{"status":"suspended","enforcement":"all"}'

# 立即停服
curl -X PATCH localhost:8787/admin/licenses/<id> $H -d '{"status":"suspended"}'

# 到期前预警（active 时只透传显式文案，不影响功能）
curl -X PATCH localhost:8787/admin/licenses/<id> $H -d '{"notice":"试用剩余 3 天，请及时续期"}'

# 加快心跳（e2e 演练用）
curl -X PATCH localhost:8787/admin/licenses/<id> $H -d '{"heartbeatIntervalSec":10,"graceSec":120}'
```

### `GET /admin/keys` — 签名密钥列表

响应：

```json
{
  "keys": [
    {
      "keyId": "7d1e307a427ea52f",
      "publicKey": "-----BEGIN PUBLIC KEY-----\n...",
      "createdAt": "...",
      "retired": false
    },
    {
      "keyId": "fd32b3f87862288b",
      "publicKey": "-----BEGIN PUBLIC KEY-----\n...",
      "createdAt": "...",
      "retired": true
    }
  ]
}
```

含已退休的密钥——便于轮换期验历史签名，也便于审计。

### `POST /admin/keys/rotate` — 轮换签名密钥

无请求体。

语义：

1. 当前 active 密钥标记为 `retired`（`retiredAt = now`）
2. 生成新 Ed25519 密钥对，入库为 active
3. **后续签发只用新钥**

响应：`{ keyId: <new>, publicKey: <new PEM> }`

**⚠ 有副作用的操作**（见 ADR-013）：所有持有旧公钥的 App 会**立即**看到
`signature.kind: invalid`，进入最严处置（enforcement=all、features 全拒、notice 换安全告警）。
运营方必须协调好"通知所有 App 运营方更新 `GENUINE_PUBLIC_KEY` 并重启"再 rotate，或接受
一段全站 503 的窗口。

端到端联调（2026-10-14）已实测此路径：rotate → App `signature.kind: invalid` + reason
精确报 `keyId 不匹配（响应 X，本地公钥 Y）：中心可能已轮换密钥` → 换 pubkey 重发布 →
恢复 `verified+active`。

## 输入 / 输出

见上各端点。所有响应都是 JSON；错误响应统一形状：

```json
{ "error": "<GENUINE_ERROR_CODES 之一>", "message": "<人类可读>" }
```

错误码集中在 `contract.ts` 的 `GENUINE_ERROR_CODES`，消费侧可据此区分"授权问题"与
"网络问题"（后者要走 fail-open，前者不该）。

## 约束

- **未配 `GENUINE_ADMIN_TOKEN` 时 `/admin/*` 整体 503**，绝不降级为匿名可管（见 ADR-009）
- Bearer token 用 `timingSafeEqual` 比对（防时序攻击）
- **密钥材料不出现在任何响应体与日志里**：`licenseKey` 原文、私钥 PEM 都不回显；对外只给
  `keyId` 与公钥
- 管理端点**不做业务判断**——只做请求解析、鉴权、调 `service.ts`、编码响应
- 所有时间字段用 ISO 8601 字符串（UTC）；DB 里存 ms epoch 整数

## 边界条件

- **token 长度不等**：`timingSafeEqual` 会抛异常，需先比长度再比内容
- **token 含非 ASCII**：`Buffer.from(token)` 按 UTF-8 编码，两侧一致即可
- **`PUT /admin/products/:id` 重复调用**：upsert 语义，幂等
- **`POST /admin/licenses` 缺 `productId`/`appId`**：400 bad_request
- **`POST /admin/licenses` 的 `productId` 不存在**：404 product_not_found
- **`PATCH /admin/licenses/:id` 的 `id` 不存在**：404 license_not_found
- **`PATCH` 传空对象 `{}`**：200，但什么都不改
- **`POST /admin/keys/rotate` 重复调用**：每次都生成新钥、退休旧钥。多次 rotate 会积累
  多把退休钥（`GET /admin/keys` 全返回）
- **并发 PATCH 同一 license**：sqlite 事务保证串行化，后写覆盖先写（无乐观锁）

## 验收标准

- [x] 未配 token → `/admin/*` 全部 503
- [x] 错误 token → 401 unauthorized
- [x] 正确 token → 放行
- [x] `timingSafeEqual` 防时序攻击（长度不等时先比长度）
- [x] `PUT /admin/products/:id` upsert 幂等
- [x] `POST /admin/licenses` 缺必填字段 → 400
- [x] `POST /admin/licenses` 的 productId 不存在 → 404
- [x] `PATCH /admin/licenses/:id` 的 undefined 不改、null 有专门语义
- [x] `GET /admin/licenses` 支持 productId/appId 过滤
- [x] 响应不回显 licenseKey 原文与私钥
- [x] `POST /admin/keys/rotate` 退休旧钥、生成新钥、后续签发用新钥
- [x] `GET /admin/keys` 返回含退休钥的完整列表
- [x] rotate 后持有旧公钥的 App 立即 invalid sig（2026-10-14 Pages 端到端实测）

## 完成定义

- 如何判定已完成：`app.test.ts` 全绿（11 项），且端到端联调覆盖所有典型运营动作
  （建产品、签发、调整、停服、rotate）。
