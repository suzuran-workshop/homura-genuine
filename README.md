# homura-genuine

homura 系列轻应用的**中央授权服务**：签发许可证、设定并随时调整到期时间、按许可证下发功能范围，
用 Ed25519 签名保证 App 侧无法篡改授权。消费侧是 `../homura` 的 `@homurajs/license`。

## 解决什么

制作人把 AI 生成的轻应用散布出去之后，需要保留运行控制权：

1. **到期控制**：每个 App 实例有到期时间，中心可随时调整；消费侧一旦发现过期，按中心设置的
   处置强度禁用全部/核心功能，并对**所有用户每次使用**强提醒。
2. **功能范围**：每张许可证携带**签名**的功能清单，App 侧逐点校验，从而对不同持有者开放不同能力。
3. **即时停服**：中心标记 suspended，App 下一次心跳即全站 503（fail-open 语义见 ADR：
   网络失联走宽限期，中心明示停服立即生效）。

签名是这套东西的支点：授权若用对称密钥，App 产物里就得带同一把钥匙，而产物会分发到别人的部署环境
——拿到产物即可自签"永不过期 + 全功能"。故中心持私钥签发，App 只嵌公钥验证。

## 技术栈

**后端**（`apps/server`）：Hono 4 + TypeScript 5.9（strict，含 `noUncheckedIndexedAccess`）+ `node:sqlite`（单文件库）+
`node:crypto` 的 Ed25519。**server 运行时依赖只有 hono 与 @hono/node-server**，其余全是 Node 内置。
无打包器：dev 用 tsx，prod 用 `node --experimental-strip-types` 直跑 TS。vitest，测试与实现同文件 colocate。

**契约**（`packages/contract`）：跨仓库逐字同步的 `contract.ts` + 中心内部的管理端点类型 `admin.ts`，
零构建 TS 源码直引（exports 指向 `./src/*.ts`）。

**前端**（`apps/web`）：Vite 8 + React 19 + Tailwind CSS v4 + shadcn/ui（Radix）+ react-router v7。
管理台是**内部运营工具，同源托管于 server，永不分发进 App 产物**——故 React 生态依赖不受
「server 运行依赖只有 hono」约束（该约束只针对会被打进 App bundle 的 server 与 contract）。

**仓库形态**：pnpm workspaces monorepo（`apps/*` + `packages/*`），无 turbo/nx。

## 跑起来

```bash
pnpm install

# 开发：并发起 server(tsx watch, :8787) + web(vite, :5173，代理 /admin /v1 /healthz 到 8787)
GENUINE_ADMIN_TOKEN=$(openssl rand -hex 24) pnpm dev

# 生产：先构建前端，再单进程同源托管（server 挂 apps/web/dist，:8787 一个端口搞定）
pnpm build
GENUINE_ADMIN_TOKEN=... pnpm start
```

管理台在浏览器打开 `http://127.0.0.1:8787/`（生产）或 `http://localhost:5173/`（开发），
登录时输入服务端的 `GENUINE_ADMIN_TOKEN`。

启动日志会打印**签名公钥与 keyId**——把它配到 App 侧（homura 的 `GENUINE_PUBLIC_KEY` /
`GENUINE_KEY_ID`，经 `config/homura.config.env` 投递）。首次启动自动生成密钥并入库。

环境变量（也可写进仓库根的 `.env`，`pnpm start` 用 `node --env-file-if-exists=../../.env` 自动读；
`.env` 不存在则静默跳过，不报错）：

| 变量                    | 缺省                       | 说明                                                                  |
| ----------------------- | -------------------------- | --------------------------------------------------------------------- |
| `GENUINE_PORT` / `PORT` | 8787                       | 监听端口                                                              |
| `GENUINE_HOST` / `HOST` | 127.0.0.1                  | 监听地址                                                              |
| `GENUINE_DB_PATH`       | `<仓库根>/data/genuine.db` | sqlite 文件（`:memory:` 仅测试）；相对路径**锚定仓库根**而非 cwd      |
| `GENUINE_ADMIN_TOKEN`   | 无                         | 管理接口 bearer token；**未设置则 `/admin/*` 全部 503，管理台不可用** |
| `GENUINE_LOG_LEVEL`     | info                       | 日志级别                                                              |

⚠ `data/` 与 `*.pem` 已在 `.gitignore`：DB 文件里有签名私钥，等同于密钥保管。
⚠ `GENUINE_DB_PATH` 的相对路径按**仓库根**解析（`repoRoot()`，向上找 `pnpm-workspace.yaml`），
不是 `process.cwd()`——monorepo 下 `pnpm --filter` 会让 cwd 变成 `apps/server`，若不锚定会在
`apps/server/data/` 新建空库，看着像授权数据全丢。绝对路径与 `:memory:` 原样透传。

## 接口

**契约端点**（App 调用，路径与类型见 `packages/contract/src/contract.ts`，与消费侧逐字同步）

| 端点                 | 说明                                                                    |
| -------------------- | ----------------------------------------------------------------------- |
| `POST /v1/register`  | `{productId, appId, instanceKey, licenseKey?}` → 绑定实例并下发签名授权 |
| `POST /v1/heartbeat` | `{licenseId, instanceKey}` → 刷新 lastSeenAt 并下发最新签名授权         |
| `GET /v1/keys`       | 公钥列表（含已退休的，便于轮换期验旧签名）                              |
| `GET /healthz`       | 存活检查                                                                |

**管理端点**（中心运营，全部要 `Authorization: Bearer $GENUINE_ADMIN_TOKEN`）

| 端点                                          | 说明                                                                                                                                                      |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUT /admin/products/:id`                     | 建/改产品：`defaultFeatures` `defaultEnforcement` `defaultTtlDays` `allowSelfRegister`                                                                    |
| `GET /admin/products`                         | 产品列表                                                                                                                                                  |
| `POST /admin/licenses`                        | 签发许可：`productId` `appId` `licenseKey?` `expiresInDays?`/`expiresAt?` `enforcement?` `features?` `notice?`                                            |
| `GET /admin/licenses?productId=&appId=`       | 列表（含 `effectiveStatus` / `expired`，不回显 licenseKey 与私钥）                                                                                        |
| `GET /admin/licenses/:id`                     | 单条详情（同列表项形状）                                                                                                                                  |
| `PATCH /admin/licenses/:id`                   | **随时调整**：`expiresInDays`/`expiresAt`（`null` = 永不过期）、`enforcement`、`features`、`notice`、`status`（active/suspended/revoked）、心跳与宽限参数 |
| `GET /admin/keys` · `POST /admin/keys/rotate` | 查看/轮换签名密钥（旧钥退休后仍可用于验历史签名）                                                                                                         |

### 处置强度（enforcement）

`status` 不是 active 时，消费侧按下表处置；**无论哪一档，都会每次响应带强提醒**（`notice`）。
`active` 时若中心显式写了 `notice`（到期前预警、运营通知），消费侧也会照常展示，但不影响任何功能——
自动生成的文案只在非 active 时出现：

| 值       | 消费侧行为                                                              |
| -------- | ----------------------------------------------------------------------- |
| `none`   | 只记录，功能全开、不提醒（观察期用；`active` 时中心恒下发此值）         |
| `notice` | 功能全开，但每个响应带 `X-Homura-License-Notice`，前端每次使用都要展示  |
| `core`   | 禁核心功能（App 用 `corePaths` 声明哪些算核心）→ 503，其余放行 + 强提醒 |
| `all`    | 全站 503（豁免路径除外）+ 强提醒                                        |

### 典型运营动作

```bash
H='-H "authorization: Bearer $GENUINE_ADMIN_TOKEN" -H "content-type: application/json"'

# 建产品（默认 30 天、到期禁核心功能、开放 basic+export）
curl -X PUT localhost:8787/admin/products/pro -H "authorization: Bearer $T" -H 'content-type: application/json' \
  -d '{"name":"Pro","defaultFeatures":["basic","export"],"defaultEnforcement":"core","defaultTtlDays":30}'

# 签发一张一年期许可
curl -X POST localhost:8787/admin/licenses -H "authorization: Bearer $T" -H 'content-type: application/json' \
  -d '{"productId":"pro","appId":"app-1","licenseKey":"LIC-1","expiresInDays":365,"features":["basic","export"]}'

# 延期 / 缩短 / 改成永不过期
curl -X PATCH localhost:8787/admin/licenses/<id> -H "authorization: Bearer $T" -H 'content-type: application/json' -d '{"expiresInDays":90}'
curl -X PATCH localhost:8787/admin/licenses/<id> -H "authorization: Bearer $T" -H 'content-type: application/json' -d '{"expiresAt":null}'

# 加功能、改处置强度、立即停服
curl -X PATCH localhost:8787/admin/licenses/<id> ... -d '{"features":["basic","export","ai"]}'
curl -X PATCH localhost:8787/admin/licenses/<id> ... -d '{"enforcement":"all"}'
curl -X PATCH localhost:8787/admin/licenses/<id> ... -d '{"status":"suspended"}'
```

## 数据模型

`products`（默认功能范围/处置强度/TTL/是否允许自助注册）· `licenses`（实例绑定、手动状态、
到期、处置强度、功能范围、提醒文案、心跳参数、lastSeenAt）· `signing_keys`（Ed25519 密钥对 + 退休时间）。

**有效状态**是算出来的，不是存出来的：`revoked|suspended`（手动）→ `suspended`；
`expiresAt` 已过 → `expired`；否则 `active`。`grace` 与 `unknown` 只存在于消费侧
（心跳失联宽限 / 未注册 / 验签失败），中心从不下发。

**自助注册语义**：产品开了 `allowSelfRegister` 时，任何 `(product, app, instanceKey)` 组合首次注册
都会新签一张许可——即**不做实例管控**。要"一份授权只跑一个实例"就别开它，改由中心预签发 +
`licenseKey` 分发；那样换实例复用同一把 key 会得到 `instance_mismatch`（403），即盗用信号。

## 契约同步（重要）

`packages/contract/src/contract.ts` 与 `../homura/packages/license/src/contract.ts` **必须逐字一致**
（含 `canonicalize` 与 `verifyEntitlement`——它们决定签名字节与验签判定，两侧不一致就等于验签失效）。
改契约 = 同步两侧 + 跑 parity 测试 + 在两侧 DECISIONS/spec 留痕。详见 `AGENTS.md`。

⚠ 该文件已列入 `.prettierignore`：字节形态由跨仓库同步协议管辖，**不归 formatter**——`.prettierrc` 的
`endOfLine: lf` 会把 CRLF 改成 LF，一跑 `pnpm format` 就会破坏字节级 parity（表现为「契约漂移」）。

同目录的 `admin.ts`（管理端点类型）是**中心内部契约**，App 侧永不调 `/admin/*`，故不纳入 parity、可自由演进。
它只允许 `import type` 引用 `contract.ts`（禁 re-export 运行值），否则 `node:crypto` 会经它泄漏进 web bundle。

## 文档

- `docs/PRD.md` — 产品目标、用户场景、功能表、范围与非目标
- `docs/ARCHITECTURE.md` — 系统概述、模块表、数据流、外部系统、技术边界
- `docs/DECISIONS.md` — 19 条 ADR（签名方案、状态计算、契约同步、密钥轮换、monorepo 布局等）
- `docs/specs/module-contract.md` — 契约与签名的行为/约束/验收
- `docs/specs/module-lifecycle.md` — register/heartbeat/adjust 与有效状态机
- `docs/specs/module-admin.md` — 管理端点鉴权与典型运营动作
- `docs/specs/module-web-admin.md` — 管理台页面、鉴权流程、401/503 分流、验收

## 开发

monorepo 用 pnpm workspaces（`apps/*` + `packages/*`），根脚本编排各子包：

```bash
pnpm dev          # concurrently 起 server(tsx watch, :8787) + web(vite, :5173 代理到 8787)
pnpm build        # 只构建 web（server 无构建步骤，prod 直跑 TS）
pnpm start        # 生产：单进程同源托管 apps/web/dist
pnpm test         # vitest：canonicalize、签名/篡改/轮换、到期与处置、HTTP 全生命周期、静态托管、契约 parity
pnpm typecheck    # pnpm -r typecheck（三包各自 tsc --noEmit）
pnpm format       # prettier（contract.ts 已被 .prettierignore 冻结）
```

单包调试用 `pnpm --filter @homura-genuine/{server,web,contract} <script>`。
