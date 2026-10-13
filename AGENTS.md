# AGENTS.md

homura-genuine：homura 系列轻应用的中央授权服务（许可证签发、到期与功能范围控制、Ed25519 签名下发）。
消费侧是 `../homura` 的 `@homurajs/license`——两个仓库通过 `src/contract.ts` 耦合，别无其他依赖。

## 概述

- 本项目是什么：制作人保留"散布出去的 AI 轻应用"运行控制权的中心侧实现。独立部署，不上 qw-pages
- 边界：只做授权签发与查询。**不做** OAuth/登录（归 `../oauth2-dingtalk`）、不做业务数据、不做多租户组织模型

## Agent 操作指南

- 如何理解本项目：先读 README.md（能力与接口），再读 `src/contract.ts`（唯一契约事实源），
  然后 `src/service.ts`（状态与签发规则）。HTTP 层（`src/app.ts`）只是薄封装，业务判断都在 service
- 改动前必查：`src/contract.ts` 是否被动到。**动它 = 动跨仓库契约**，见下方硬规则

- 全局规则 / 约定（与 ../homura 保持一致，降低 Agent 在两仓库间切换的成本）：
  - **`src/contract.ts` 不许随手改**：它与 `../homura/packages/license/src/contract.ts` 必须逐字一致
    （含 `canonicalize` 与 `verifyEntitlement`——两侧不一致等于验签静默失效）。
    改契约的流程：同步两侧文件 → 两侧各自跑测试 → 两侧各写 ADR/spec 留痕。
    逐字比对由 parity 测试守住（`src/contract-parity.test.ts`，随消费侧同步一并落地）
  - contract.ts **只允许依赖 Node 内置**：它会被 App 侧打进 bundle，引第三方等于给所有派生 App 加依赖
  - 依赖方向：本仓库**不依赖 homura 任何包**（授权中心依赖被授权方是反向耦合）。需要的类型/工具在 contract.ts 里各自持有一份
  - 业务规则集中在 `service.ts`，HTTP 层不做判断；`db.ts` 只做存取，不含业务
  - TS strict 全开（含 `noUncheckedIndexedAccess`）；测试与实现同文件 colocate（`*.test.ts`）
  - 新导出必有测试；时间一律走 `now` 参数注入（缺省 `Date.now()`），测试不依赖真实时钟、不 sleep
  - 布尔在 sqlite 里存 0/1（`node:sqlite` 不接受 boolean 绑定）；时间存 ms epoch 整数；数组存 JSON 文本
  - 管理端点**必须**鉴权：`GENUINE_ADMIN_TOKEN` 未配置时 `/admin/*` 整体 503，绝不降级为匿名可管
  - 密钥材料（私钥、licenseKey 原文）不出现在任何响应体与日志里；对外只给 `keyId` 与公钥
  - 文档全 UTF-8 简体中文；commit 遵循 Conventional Commits（type/scope 英文、描述简体中文、subject ≤72 字符）

## 关键设计判断（改代码前先读）

- **有效状态是算出来的**：`revoked|suspended` → suspended；`expiresAt` 已过 → expired；否则 active。
  不要把它存进 DB，否则"随时调整期限"会出现存算不一致
- **到期在消费侧也要本地判定**（不等心跳）：需求是"只要发现过期就处置"。中心下发 `serverTime`
  供消费侧校正时钟偏差，防止用户回拨系统时间绕过到期
- **签名覆盖整个授权载荷**（含 `instanceKey` 与 `expiresAt`）：把 instanceKey 签进去才能防重放到别的实例；
  把 expiresAt 签进去才能防篡改到期日。加字段时记得它自动进签名（`canonicalize` 全量序列化）
- **处置强度与状态分离**：`status` 说"发生了什么"，`enforcement` 说"该拦多少"，`notice` 说"怎么告诉用户"。
  三者都由中心控制、可随时调整；`active` 时 enforcement 恒为 `none`，不给消费侧留误拦的余地
- **强提醒是无条件的**：只要 status 非 active 就一定有 notice 文案（中心没写就自动生成），
  因为"每次使用强提醒、无差别提示所有用户"是硬要求，不能依赖运营记得填。
  active 时**只透传中心显式写的**文案（到期前预警用），不自动生成、也不影响功能
- **自助注册 = 放弃实例管控**：`allowSelfRegister` 开着时每个 instanceKey 各签一张。
  要一实例一授权就关掉它、走 licenseKey 预签发（换实例复用会撞 `instance_mismatch` 403）

## 目录速查

- `src/contract.ts` — 唯一契约事实源：状态/处置强度/授权载荷类型、端点常量、错误码、`canonicalize`、`verifyEntitlement`、`isEntitlementExpired`
- `src/sign.ts` — 签发侧：Ed25519 密钥生成与签名（验签在 contract.ts，两侧共用）
- `src/db.ts` — `node:sqlite` 存储层：products / licenses / signing_keys
- `src/service.ts` — 业务规则：有效状态、到期、功能范围、提醒文案、register/heartbeat、签发与调整
- `src/app.ts` — Hono 装配：契约端点（公开）+ 管理端点（bearer）+ 公钥分发
- `src/env.ts` — 配置装载（无默认密钥；未配 token 则管理接口禁用）
- `src/server.ts` — 入口：监听 PORT/HOST，启动时打印公钥与 keyId
