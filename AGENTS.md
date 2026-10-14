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

**monorepo 布局**：pnpm workspaces（`apps/*` + `packages/*`），无 turbo/nx。
`apps/server`（Hono 后端，无构建步骤，prod 直跑 TS）+ `apps/web`（React 管理台）+ `packages/contract`（契约，零构建源码直引）。

- `packages/contract/src/contract.ts` — **唯一契约事实源**（与 `../homura` 逐字一致）：状态/处置强度/授权载荷类型、端点常量、错误码、`canonicalize`、`verifyEntitlement`、`isEntitlementExpired`。已列入 `.prettierignore`（字节形态归同步协议管）
- `packages/contract/src/admin.ts` — 管理端点类型（`AdminProduct`/`AdminLicense`/各 Body 与信封）。**中心内部契约，不纳入 parity**；只允许 `import type` 引用 contract.ts（禁 re-export 运行值，防 `node:crypto` 泄漏进 web bundle）
- `apps/server/src/sign.ts` — 签发侧：Ed25519 密钥生成与签名（验签在 contract.ts，两侧共用）。**中心专属，不进 contract 包**
- `apps/server/src/db.ts` — `node:sqlite` 存储层：products / licenses / signing_keys
- `apps/server/src/service.ts` — 业务规则：有效状态、到期、功能范围、提醒文案、register/heartbeat、签发与调整、对外视图 `describe`/`describeProduct`
- `apps/server/src/app.ts` — Hono 装配：契约端点（公开）+ 管理端点（bearer）+ 公钥分发 + 可选静态托管
- `apps/server/src/static.ts` — 手写静态托管中间件（同源托管 web dist）。**不用 `@hono/node-server/serve-static`**（tsx#623，见 ADR-018）
- `apps/server/src/paths.ts` — `repoRoot()`：向上找 `pnpm-workspace.yaml` 定位仓库根（cwd 相对路径全部经它锚定，见 ADR-016）
- `apps/server/src/env.ts` — 配置装载（无默认密钥；未配 token 则管理接口禁用；`DB_PATH` 相对路径锚定 repoRoot）
- `apps/server/src/server.ts` — 入口：监听 PORT/HOST，启动时打印公钥与 keyId，传 webRoot 挂静态托管
- `apps/web/src/` — 管理台：`pages/*`（7 页）、`lib/{api,auth,session,format}`（api 含 401/503 分流 + 陈旧 401 防护）、`components/ui/*`（shadcn）、`hooks/useApi.ts`。详见 `docs/specs/module-web-admin.md`
- `docs/PRD.md` — 产品目标、用户场景、功能表、范围与非目标
- `docs/ARCHITECTURE.md` — 系统概述、模块表、数据流、外部系统、技术边界
- `docs/DECISIONS.md` — 19 条 ADR（签名方案、状态计算、契约同步、密钥轮换、monorepo 布局等）
- `docs/specs/module-contract.md` — 契约与签名的行为/约束/验收
- `docs/specs/module-lifecycle.md` — register/heartbeat/adjust 与有效状态机
- `docs/specs/module-admin.md` — 管理端点鉴权与典型运营动作
- `docs/specs/module-web-admin.md` — 管理台页面、鉴权流程、401/503 分流、验收

## monorepo 开发要点（改代码前必读）

- **命令在仓库根跑**：`pnpm dev`（concurrently 起 server+web）、`pnpm build`（只构建 web）、`pnpm start`（prod 同源托管）、`pnpm test`（`test.projects` 聚合三包）、`pnpm typecheck`（`pnpm -r`）。单包调试用 `pnpm --filter @homura-genuine/{server,web,contract} <script>`
- **server/contract 受「零运行依赖」约束，web 不受**：ADR-011「只依赖 Node 内置」约束的是会被打进 App 产物的 `contract.ts`；ADR-014「运行依赖只有 hono」约束的是 `apps/server`。`apps/web` 是**内部运营工具、永不分发进 App 产物**，正常引入 React 生态依赖（见 ADR-015）
- **prod 直跑 TS 的硬约束**：server 无打包器，`node --experimental-strip-types` 只擦除类型、**不做 `.js`→`.ts` 重写**，故 server/contract 内部相对 import 一律写 `.ts` 后缀（`tsconfig.base.json` 开了 `allowImportingTsExtensions`）。**类型擦除不支持 enum / namespace / 构造函数参数属性**——server 与 contract 里禁用（dev 用 tsx 全量转换能过，prod 纯 node 会静默崩）
- **契约 parity 是最高优先门禁**：`contract.ts` 与 `../homura` 逐字一致，`contract-parity.test.ts` 守门。它的 PEER 相对路径依赖目录层级（现退三级到仓库根再 `../homura`）；skip 判据是「对端**仓库**存在」——仓库在而文件不在会**显式失败**而非静默跳过。任何挪动 contract.ts 位置的操作都要复核这条路径
- **改 contract.ts = 改跨仓库契约**：同步两侧 → 两侧跑测试 → 两侧写 ADR/spec。别用 `pnpm format`（已 prettierignore 冻结）。`admin.ts` 不在此列，可自由改
