# ARCHITECTURE — homura-genuine

## 系统概述

单进程 Node.js 服务，运行时依赖只有 `hono`；存储用 `node:sqlite` 单文件库；签名用 `node:crypto`
的 Ed25519。**没有任何出向网络调用**——它只被消费侧调用，不主动连任何外部系统。

```
                    ┌─────────────────────────────────────────┐
                    │         homura-genuine 进程             │
                    │                                         │
  消费侧 App ─────► │  server.ts (监听 PORT/HOST)             │
  (../homura        │      │                                  │
   @homurajs/       │      ▼                                  │
   license)         │  app.ts (Hono 装配)                     │
                    │      ├── /healthz                       │
                    │      ├── /v1/keys      ─┐               │
                    │      ├── /v1/register   │ 契约端点      │
                    │      ├── /v1/heartbeat ─┘ (公开)        │
                    │      │                                  │
                    │      └── /admin/*      (Bearer token)   │
                    │             │                           │
                    │             ▼                           │
                    │       service.ts (业务规则)             │
                    │             │                           │
                    │      ┌──────┼──────┐                    │
                    │      ▼      ▼      ▼                    │
                    │   sign.ts  db.ts  contract.ts           │
                    │  (Ed25519)(sqlite)(契约类型/验签)        │
                    │                                         │
                    │             │                           │
                    │             ▼                           │
                    │        ./data/genuine.db                │
                    │      (products/licenses/signing_keys)   │
                    └─────────────────────────────────────────┘
```

`contract.ts` 是**跨仓库契约的唯一事实源**：与 `../homura/packages/license/src/contract.ts`
必须逐字一致（含 `canonicalize`/`normalizePem`/`verifyEntitlement`——它们决定签名字节与
keyId，不一致等于验签静默失效）。由 `contract-parity.test.ts` 逐字比对守门。

## 核心模块

| 模块 | 文件              | 职责                                                                                                                                                                                                                                                                                |
| ---- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 契约 | `src/contract.ts` | 状态/处置强度/授权载荷类型；端点常量；错误码；`canonicalize`（确定性序列化）；`normalizePem`（PEM 归一）；`keyIdOf`；`verifyEntitlement`（消费侧共用）；`isEntitlementExpired`（本地到期判定）。**只允许依赖 Node 内置**——会被 App 侧打进 bundle                                    |
| 签名 | `src/sign.ts`     | 签发侧专用：Ed25519 密钥生成、`signEntitlement(entitlement, privatePem)`。验签在 contract.ts（两侧共用）                                                                                                                                                                            |
| 存储 | `src/db.ts`       | `node:sqlite` 存储层。三张表：`products` / `licenses` / `signing_keys`。**只做存取，不含业务**。布尔存 0/1、时间存 ms epoch 整数、数组存 JSON 文本                                                                                                                                  |
| 业务 | `src/service.ts`  | 全部业务规则：有效状态计算（`revoked\|suspended` → suspended；`expiresAt` 已过 → expired；否则 active）、TTL 到期、功能范围、提醒文案自动生成、`register`/`heartbeat`/`issueLicense`/`adjustLicense`。**时间参数化**（`now` 注入，缺省 `Date.now()`），测试不依赖真实时钟、不 sleep |
| HTTP | `src/app.ts`      | Hono 装配：契约端点公开，管理端点走 Bearer token 中间件（`timingSafeEqual` 比对）。**HTTP 层不做业务判断**——只做请求解析、鉴权、结果编码                                                                                                                                            |
| 配置 | `src/env.ts`      | 环境变量装载（`GENUINE_PORT`/`HOST`/`DB_PATH`/`ADMIN_TOKEN`/`LOG_LEVEL`）。无默认密钥；未配 token 则管理接口整体禁用                                                                                                                                                                |
| 入口 | `src/server.ts`   | 监听 PORT/HOST，启动时确保签名密钥存在（首次启动自动生成 + 入库），打印公钥与 keyId                                                                                                                                                                                                 |

## 模块关系

- **依赖方向单向向下**：`server` → `app` → `service` → `sign`/`db`/`contract`
- **`contract.ts` 无依赖**（只用 Node 内置 `node:crypto`）；被 `service.ts` 与 `sign.ts` 双向使用，
  也被 App 侧（`../homura/packages/license`）打进 bundle
- **反向依赖禁令**：本仓库不依赖 `../homura` 的任何包。授权中心依赖被授权方是反向耦合——
  需要的类型/工具在 `contract.ts` 里各自持有一份
- **业务规则集中在 `service.ts`**：`app.ts` 是薄封装，只做请求解析与鉴权；`db.ts` 是存取原语，
  不含"到期怎么算""文案怎么生成"这类判断

## 数据流

### 消费侧激活（`POST /v1/register`）

```
App 首次启动
  │
  ├── 生成本地 instanceKey（持久化到 App 侧 license_state 表）
  │
  ▼
POST /v1/register { productId, appId, instanceKey, licenseKey? }
  │
  ▼
app.ts: 请求解析
  │
  ▼
service.register(input, now)
  │
  ├── 查 product（不存在 → 404 product_not_found）
  ├── 分支 A: 带 licenseKey
  │     ├── 查 licenses WHERE license_key = ?
  │     ├── 若已绑别的 instanceKey → 403 instance_mismatch
  │     └── 否则绑当前 instanceKey
  ├── 分支 B: 无 licenseKey
  │     ├── 若 product.allow_self_register = 0 → 403 self_register_disabled
  │     └── 否则新建 license（用 product 的 default_features/enforcement/ttl_days）
  ├── 计算 effectiveStatus（active/suspended/expired）
  ├── 构造 LicenseEntitlement（含 serverTime = now）
  ▼
sign.signEntitlement(entitlement, activePrivateKey)
  │
  ▼
返回 { licenseId, status, heartbeatIntervalSec, graceSec, issuedAt, license: SignedEntitlement }
```

### 心跳（`POST /v1/heartbeat`）

```
App 每 heartbeatIntervalSec 秒触发一次
  │
  ▼
POST /v1/heartbeat { licenseId, instanceKey, metrics? }
  │
  ▼
service.heartbeat(input, now)
  │
  ├── 查 license（不存在 → 404 license_not_found）
  ├── 校验 instanceKey（不符 → 403 instance_mismatch）
  ├── UPDATE lastSeenAt = now
  ├── 重新计算 effectiveStatus（可能已过期或被 PATCH 改过）
  ├── 重新构造 entitlement（含最新字段 + serverTime = now）
  ▼
sign.signEntitlement(...)
  │
  ▼
返回 { status, heartbeatIntervalSec, serverTime, notice?, license: SignedEntitlement }
```

App 侧收到响应后：

1. 用内嵌公钥 `verifyEntitlement(signed, publicKey)` → `verified | invalid | unverified`
2. `verified` 时采信载荷全部字段；`invalid` 时进入最严处置（enforcement=all、features 全拒、
   notice 换安全告警）
3. 用 `serverTime` 校正本地时钟偏差，然后本地判定 `expiresAt < correctedNow` → 立即 expired
   （不等下一次心跳）

### 管理调整（`PATCH /admin/licenses/:id`）

```
运营 → PATCH { expiresAt | expiresInDays | enforcement | features | notice | status | heartbeatIntervalSec | graceSec }
  │
  ▼
service.adjustLicense(id, patch, now)
  │
  ├── 只更新传入的字段（undefined = 不改；null 有专门语义：expiresAt: null = 永不过期）
  ├── 存 DB
  ▼
下一次心跳（≤ heartbeatIntervalSec 秒后）时，新字段随签名授权下发到 App
```

## 外部系统

**无出向依赖**。genuine 不主动连任何外部系统：

- 不发邮件/短信（提醒走 App 侧响应头 + UI banner，中心不直接联系终端用户）
- 不对接支付（到期时间由运营手动或运营的外部系统 PATCH 进来）
- 不做日志聚合（`GENUINE_LOG_LEVEL` 只控制 stderr 输出级别）
- 不做监控上报（`/healthz` 被动等探针）

**入向依赖**：

- 消费侧 App（`../homura` 的 `@homurajs/license`）通过 `POST /v1/register` + `POST /v1/heartbeat`
  访问契约端点。App 必须以 https 公网可达 genuine（Pages 出网只放行 443）
- 运营通过 `Authorization: Bearer $GENUINE_ADMIN_TOKEN` 访问 `/admin/*` 管理端点

## 重要技术边界

### 契约边界：contract.ts 逐字一致

`src/contract.ts` 与 `../homura/packages/license/src/contract.ts` 必须**逐字一致**。
`canonicalize` 决定签名字节，`normalizePem` 决定 keyId——任何一侧漂移都等于验签静默失效。
`contract-parity.test.ts` 会读出两侧文件逐字比对，报出首个不同行号并给出"cp 覆盖、别手工合并"
的修法。改契约的流程：同步两侧文件 → 两侧各自跑测试 → 两侧各写 ADR/spec 留痕。

### 密钥边界：私钥不出进程

Ed25519 私钥只在 `signing_keys` 表里，只在 `signEntitlement` 时被读取，**从不出现在任何响应体、
日志、错误信息里**。对外只给 `keyId` 与公钥。DB 文件本身等同于密钥保管——`data/` 与 `*.pem`
已在 `.gitignore`。

### 授权边界：管理端点强鉴权

未配 `GENUINE_ADMIN_TOKEN` 时 `/admin/*` 整体 503，**绝不降级为匿名可管**。Bearer token 用
`timingSafeEqual` 比对（防时序攻击）。契约端点（`/v1/*`、`/healthz`）无需鉴权——它们的
安全性由签名与 `instanceKey` 绑定保障。

### 存储边界：单文件 sqlite

`node:sqlite` 是 Node 22.5+ 的内置模块，运行时零依赖。单文件 `./data/genuine.db` 承载
所有状态。**这是当前设计上限**——不支持水平扩展，也没有复制。要 HA 得先解决私钥托管
（HSM/KMS）与 sqlite 复制（Litestream/rqlite），那是另一个项目。

### 时间边界：参数化注入

所有业务函数接受 `now` 参数（缺省 `Date.now()`）。测试全部走注入的固定时刻，不 sleep、不依赖
真实时钟。这让"到期"、"心跳超时"、"宽限期"这些时间敏感逻辑可以被单测穷尽覆盖。

### 状态边界：有效状态是算出来的

`effectiveStatus` **不存 DB**，每次读时算：`manualStatus` 优先（revoked/suspended → suspended），
然后 `expiresAt` 已过 → expired，否则 active。存 DB 会导致"随时调整期限"时存算不一致——
运营 PATCH 了 `expiresAt` 但忘了刷新存下来的 status，就会看到矛盾状态。

### 消费侧边界：中心不下发 grace/unknown

`grace`（心跳失联宽限期）与 `unknown`（未注册）只存在于消费侧。中心从不下发这两个状态——
它们是 App 侧对"网络问题"的处置，与"授权问题"严格分离（网络失联走 fail-open，授权问题不该）。
