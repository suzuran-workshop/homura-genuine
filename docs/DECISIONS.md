# DECISIONS

本文件记录 homura-genuine 的关键技术与产品决策。每条 ADR 独立可读，改代码前应先扫一遍相关条目。
消费侧（`../homura` 的 `@homurajs/license`）的对应决策见其仓库的 `docs/DECISIONS.md`。

## ADR-001：Ed25519 非对称签名而非对称 HMAC

- 日期：2026-10（初版实现）
- 状态：已采纳
- 背景：授权中心要保证 App 侧无法篡改"到期时间/功能范围/处置强度"。第一直觉是对称 HMAC——
  中心与 App 共享一把密钥，中心签、App 验。
- 考虑过的方案：
  - **对称 HMAC-SHA256**：密钥必须随 App 产物分发
  - **非对称 Ed25519**：中心持私钥签发，App 只嵌公钥验证
  - **RSA-2048**：也能用，但签名/公钥都更大，Node 内置 API 也没 Ed25519 简洁
  - **不签名，靠 TLS**：TLS 只保证传输，App 侧收到响应后任何本地缓存/日志/中间件都能改
- 决策：**Ed25519**。私钥只在中心的 `signing_keys` 表；公钥 PEM 配到 App 侧 `GENUINE_PUBLIC_KEY`。
- 为什么选这个：产物会分发到别人的部署环境——**拿到产物即可拿到对称密钥**，然后自签
  "永不过期 + 全功能"，等于绕过整个授权。非对称下拿到产物只能拿到公钥，无法自签。
  Ed25519 相比 RSA 签名短（64B vs 256B）、验签快、公钥短（32B），且 Node 内置支持。
- 为什么不选其他：对称方案根本达不到安全目标；RSA 只是更臃肿的替代；不签名等于没有授权。
- 后果：私钥等同于"整个授权体系的根"——`./data/genuine.db` 必须当密钥保管（已 gitignore）；
  私钥泄露 = 整个产品线的授权失效，需 rotate 并让所有 App 更新公钥。
- 何时重新审视：量子威胁成真时（Ed25519 不抗量子）；或需要多方签发时（当前是单中心）。

## ADR-002：签名覆盖整个授权载荷（含 instanceKey 与 expiresAt）

- 日期：2026-10
- 状态：已采纳
- 背景：签什么、不签什么，直接决定攻击面。
- 考虑过的方案：
  - 只签 `status`：其他字段可篡改
  - 签关键字段子集：需要维护"哪些算关键"的清单，容易漏
  - **签整个载荷**：`canonicalize(entitlement)` 全量序列化后签
- 决策：**签整个载荷**。`canonicalize` 是确定性序列化（键升序、跳过 undefined、数组保序、
  无空白），保证两侧签出的字节完全一致。
- 为什么选这个：把 `instanceKey` 签进去才能防"A 实例的授权响应重放给 B 实例"；把 `expiresAt`
  签进去才能防篡改到期日；把 `enforcement` 签进去才能防篡改者自选最宽处置。加字段时它自动
  进签名（`canonicalize` 全量），不用维护清单。
- 为什么不选其他：字段子集方案的清单一定会漏——今天想不到的字段明天就是漏洞。
- 后果：`canonicalize` 是契约的一部分，两侧必须**逐字一致**（见 ADR-008）。加字段 = 改契约 =
  同步两侧 + 走 parity 测试。
- 何时重新审视：几乎不会。这是签名方案的核心不变量。

## ADR-003：有效状态是算出来的，不存 DB

- 日期：2026-10
- 状态：已采纳
- 背景：许可有"手动状态"（active/suspended/revoked，运营显式设置）和"有效状态"
  （active/suspended/expired，用户实际看到的）。要不要把有效状态存进 DB？
- 考虑过的方案：
  - **存 DB**：读取快，但每次 PATCH `expiresAt` 都要记得同步刷新 `effectiveStatus`
  - **算出来**：每次读时按 `manualStatus + expiresAt + now` 计算
- 决策：**算出来**。`db.ts` 只存 `manual_status` 与 `expires_at`；`service.ts` 里
  `effectiveStatus(row, now)` 是纯函数。
- 为什么选这个：存 DB 会出现"存算不一致"——运营改了 `expiresAt` 到过去但没刷新存下来的
  `effectiveStatus`，App 拿到的响应就会自相矛盾。算出来则不可能不一致。
- 为什么不选其他：读性能不是瓶颈（心跳周期是秒级到分钟级，每次多算一次纯函数无所谓）。
- 后果：任何读许可的地方都要传 `now` 参数（或用缺省 `Date.now()`）。测试因此天然可控——
  注入固定 `now` 就能穷尽各种时间点。
- 何时重新审视：几乎不会。

## ADR-004：到期在消费侧本地判定，不等心跳

- 日期：2026-10
- 状态：已采纳
- 背景：需求是"到期即处置"。如果只在心跳响应里下发 `expired`，那么心跳周期（默认 300s）内
  App 仍然是 active 的——用户可以用到期后的 5 分钟。
- 考虑过的方案：
  - 只在心跳响应里判定：有最长 `heartbeatIntervalSec` 秒的窗口期
  - **消费侧本地判定**：App 侧存下 `expiresAt`，每次访问都用 `now` 本地比较
- 决策：**本地判定优先**。中心下发 `expiresAt`（签名的），App 侧每次 `getStatus()` 时本地
  比较 `expiresAt < correctedNow` → 立即 `expired`。心跳响应里的 `serverTime` 用来校正本地
  时钟偏差（防用户回拨系统时间）。
- 为什么选这个：需求就是"到期即处置"。本地判定 = 零窗口期。`serverTime` 校正 = 抗时钟回拨。
- 为什么不选其他：只在心跳里判定，等于给了 5 分钟免费窗口；不做时钟校正，用户回拨系统时间
  即可绕过到期。
- 后果：`serverTime` 必须在签名覆盖范围内（见 ADR-002），否则中间人改 `serverTime` 就能让
  App 认为"还没到期"。消费侧的到期判定逻辑必须与中心保持一致——通过 contract.ts 的
  `isEntitlementExpired` 共用同一份实现。
- 何时重新审视：几乎不会。

## ADR-005：处置强度与状态分离，`active` 时 `enforcement` 恒为 `none`

- 日期：2026-10
- 状态：已采纳
- 背景：`status` 说"发生了什么"，`enforcement` 说"该拦多少"。两者要不要合并成一个字段？
- 考虑过的方案：
  - **合并**：`status: active/notice_limited/core_limited/all_blocked/expired/suspended`
  - **分离**：`status: active/expired/suspended` + `enforcement: none/notice/core/all`
- 决策：**分离**。且消费侧 `getEnforcement()` 在 `status === 'active'` 时**恒返回 `none`**，
  不管中心下发的 `enforcement` 是什么。
- 为什么选这个：
  - 合并方案的状态空间是笛卡尔积，每加一档都要枚举所有组合，容易漏
  - 分离方案让运营可以独立调整："观察期"就是 `status: suspended` + `enforcement: none`
    （记录但不拦）；"到期前预警"就是 `status: active` + `notice: "还剩 3 天"`（不影响功能，
    只透传文案）
  - `active` 时 enforcement 恒为 `none` 是**防误拦的安全网**：中心不小心把 active 许可的
    enforcement 设成 `all`，消费侧也不会真的全站 503
- 为什么不选其他：合并方案在联调阶段就被否掉了——运营场景比状态空间更重要。
- 后果：e2e 测试要**同时** PATCH `status: suspended` 和 `enforcement: xxx` 才能看到 enforcement
  生效。只 PATCH `enforcement` 而不动 `status`，消费侧看不到任何变化——这是**设计如此**，
  不是 bug。
- 何时重新审视：如果未来引入"active 但部分受限"的场景（比如降级服务），需要重新审视这条。

## ADR-006：强提醒无条件——非 active 必有 `notice`

- 日期：2026-10
- 状态：已采纳
- 背景：产品硬要求是"每次使用强提醒、无差别提示所有用户"。如果依赖运营手动填 `notice`，
  运营忘了填就等于没提醒。
- 考虑过的方案：
  - 中心不填就不下发：依赖运营纪律
  - **消费侧自动生成兜底**：中心没填时消费侧按 `status` 自动生成默认文案
- 决策：**双层保障**。中心可以显式写 `notice`（覆盖默认）；不写时消费侧按状态自动生成
  （suspended → "本应用已被供应方停用..."；expired → "许可已过期..."；invalid sig → 固定
  安全告警）。`active` 时只透传中心**显式**写的文案（到期前预警用），不自动生成、不影响功能。
- 为什么选这个：产品要求是硬约束，不能依赖运营纪律。自动生成兜底 = 永远不会漏提醒。
- 为什么不选其他：只在中心生成会让"运营忘填"直接暴露给用户；只在消费侧生成又剥夺了运营
  自定义文案的能力。
- 后果：消费侧要有默认文案表；`invalid signature` 的告警文案是**固定的**（不采信载荷里的
  `notice`，因为载荷本身不可信）。
- 何时重新审视：几乎不会。

## ADR-007：自助注册 = 放弃实例管控

- 日期：2026-10
- 状态：已采纳
- 背景：产品面向"散布到不特定人"的场景，需要 App 首次启动就能拿到授权，不能等中心手动签发。
  但同时又需要"一份授权只跑一个实例"的场景（付费用户）。两者矛盾吗？
- 考虑过的方案：
  - **强制预签发**：所有许可都要 `POST /admin/licenses` 手动创建，App 侧配 `licenseKey`
  - **强制自助**：任何 App 都能自注册
  - **按产品切换**：`products.allow_self_register` 布尔位
- 决策：**按产品切换**。`allowSelfRegister=true` 时任何 `(product, app, instanceKey)` 组合
  首次注册都会新签一张许可——**即不做实例管控**（每个实例一张）；`false` 时必须走
  `licenseKey` 预签发，同一把 key 换实例复用会得到 `instance_mismatch`（403）——即盗用信号。
- 为什么选这个：两种场景都真实存在，硬选一种就把另一种用户拒之门外。产品级开关是最小粒度。
- 为什么不选其他：强制预签发对"试用即开即用"场景太重；强制自助对"一实例一授权"场景太松。
- 后果：e2e 测试用 `allowSelfRegister=true` 最方便（不用手动预签）；生产上付费产品应该关掉
  它、走 `licenseKey` 分发。
- 何时重新审视：引入组织/团队模型时（一张许可绑组织而非实例）需要重新设计。

## ADR-008：`contract.ts` 与消费侧逐字一致，由 parity 测试守门

- 日期：2026-10
- 状态：已采纳
- 背景：`contract.ts` 里的 `canonicalize` 决定签名字节，`normalizePem` 决定 keyId，
  `verifyEntitlement` 决定验签判定。任何一侧漂移都等于验签**静默失效**——不会报错，
  只会让 App 永远进入 `invalid` 状态或永远 `verified`（更糟）。
- 考虑过的方案：
  - **抽成第三方 npm 包**：两侧都依赖它。但会给 App 产物增加外部依赖，且版本管理复杂
  - **各持一份，靠人工同步**：一定会漂
  - **各持一份，靠 parity 测试守门**：`contract-parity.test.ts` 逐字比对两侧文件，报首个不同
    行号并给出"cp 覆盖、别手工合并"的修法
- 决策：**各持一份 + parity 测试**。同步方式是 `cp` 覆盖，**不要手工合并**。
- 为什么选这个：抽 npm 包会破坏 `contract.ts` "只依赖 Node 内置" 的约束（见 ADR-011）；
  人工同步一定会漂；parity 测试是唯一能自动守门的方式。
- 为什么不选其他：见上。
- 后果：改契约的流程 = 同步两侧文件 → 两侧各自跑测试 → 两侧各写 ADR/spec 留痕。
  单侧改就是 bug。
- 何时重新审视：如果未来出现第三个消费方（比如另一个 SDK），可能值得抽包。

## ADR-009：管理端点强鉴权，未配 token 整体 503

- 日期：2026-10
- 状态：已采纳
- 背景：`/admin/*` 能签发许可、改到期、停服、轮换密钥——等同"整个授权体系的根"。
  如果没配 token 就开放匿名访问，一次误配就是全线沦陷。
- 考虑过的方案：
  - **未配 token 时禁用管理接口**（返 404 假装不存在）：可能被误认为"接口坏了"
  - **未配 token 时返 503 + 明确错误**：让运营看到"你没配 token"
  - **未配 token 时生成一个临时 token 打日志**：日志会被收集，等于泄露
- 决策：**未配 `GENUINE_ADMIN_TOKEN` 时 `/admin/*` 整体 503**，明确错误信息。Bearer token
  用 `timingSafeEqual` 比对（防时序攻击）。
- 为什么选这个：宁可不开放，不可裸奔。503 + 明确错误比 404 更容易被运营发现。
- 为什么不选其他：见上。
- 后果：部署前必须生成 token（`openssl rand -hex 24`）并妥善保管。token 泄露 = 授权体系
  沦陷，需立即换 token 并审计。
- 何时重新审视：几乎不会。

## ADR-010：`node:sqlite` 单文件库，零运行时外部依赖

- 日期：2026-10
- 状态：已采纳
- 背景：中心需要持久化产品/许可/密钥。用什么存？
- 考虑过的方案：
  - **PostgreSQL/MySQL**：功能全但需要额外服务；单中心场景太重
  - **better-sqlite3**：常用，但是原生模块，需要 node-gyp 编译
  - **`node:sqlite`**：Node 22.5+ 内置，零依赖
  - **文件 JSON**：并发写会撞车，且没有事务
- 决策：**`node:sqlite`**。单文件 `./data/genuine.db`，运行时依赖只有 `hono`。
- 为什么选这个：genuine 是单中心服务，不需要水平扩展（见 PRD 非目标）。零外部依赖 =
  部署简单（`pnpm install && pnpm start` 就跑），且不会因为原生模块编译失败卡住部署。
- 为什么不选其他：PostgreSQL 对单中心太重；better-sqlite3 是原生模块，Windows/macOS/Linux
  都要编译；JSON 文件没事务。
- 后果：**这是当前设计上限**——不支持水平扩展，也没有复制。要 HA 得先解决私钥托管
  （HSM/KMS）与 sqlite 复制（Litestream/rqlite）。Node 版本必须 ≥ 22.5。
- 何时重新审视：需要 HA 或多中心时。

## ADR-011：`contract.ts` 只允许依赖 Node 内置

- 日期：2026-10
- 状态：已采纳
- 背景：`contract.ts` 会被 App 侧（`../homura/packages/license`）**打进 bundle**——所有
  派生 App 都会带上它。如果 contract.ts 引第三方库，等于给所有派生 App 强加依赖。
- 考虑过的方案：
  - 允许引第三方（比如 `zod` 做类型校验）：产物变大、供应链风险扩散
  - **只允许 Node 内置**：contract.ts 保持零依赖
- 决策：**只允许 Node 内置**（`node:crypto` 用于 `verifyEntitlement`）。类型校验用手写
  type guard，不引 zod。
- 为什么选这个：`@homurajs/license` 是被打进 App 产物的一部分，任何依赖都会扩散到所有
  派生 App。契约文件必须尽可能小、尽可能稳。
- 为什么不选其他：见上。
- 后果：写契约代码时不能用第三方工具，稍微啰嗦一点，但换来"零供应链风险扩散"。
- 何时重新审视：几乎不会。

## ADR-012：时间参数化注入，测试不依赖真实时钟

- 日期：2026-10
- 状态：已采纳
- 背景：到期、心跳超时、宽限期都是时间敏感逻辑。测试如果依赖真实时钟，就得 sleep——
  慢、脆、难穷尽。
- 考虑过的方案：
  - **`vi.useFakeTimers()`**：vitest 支持，但会让异步逻辑变复杂，且不能跨模块共享
  - **`now` 参数注入**：所有业务函数接受 `now: number` 参数，缺省 `Date.now()`
- 决策：**参数注入**。`service.ts` 里的 `register`/`heartbeat`/`issueLicense`/`adjustLicense`
  全部接受 `now` 参数。
- 为什么选这个：显式、可组合、无副作用。测试直接传固定时刻就能穷尽"到期前 1ms/到期时刻/
  到期后 1ms"这些边界。
- 为什么不选其他：fake timers 对异步代码有心智负担；且跨模块共享 fake 状态容易漏 reset。
- 后果：调用方（`app.ts`）负责传 `Date.now()`；service 层的所有函数签名多一个参数。
- 何时重新审视：几乎不会。

## ADR-013：密钥轮换 = 强制 App 更新公钥（旧钥退休后 App 验签失败是故意的）

- 日期：2026-10-14（Pages 端到端联调时确认）
- 状态：已采纳
- 背景：私钥泄露或到轮换周期时，`POST /admin/keys/rotate` 会退休旧钥、生成新钥。
  此时持有旧公钥的 App 会立即看到 `signature.kind: invalid`，进入最严处置
  （enforcement=all、features 全拒）。这是"事故"还是"设计"？
- 考虑过的方案：
  - **App 自动拉 `/v1/keys` 更新信任的公钥**：无缝轮换，但引入新攻击面——中间人可以在
    `/v1/keys` 响应里塞自己的公钥，App 就信任了伪造签名
  - **App 侧配多把公钥（新旧都信）**：需要 App 侧手动维护清单，且旧钥泄露时无法快速失效
  - **强制 App 运营方更新配置**：rotate 后 App 立即 invalid，运营方必须更新
    `GENUINE_PUBLIC_KEY` 并重启 App
- 决策：**强制更新**。旧钥退休后 `/v1/keys` 仍返回它（`retired: true`），供审计与历史签名
  验证；但**签发只用新钥**，App 侧配置的旧公钥会立即验签失败。
- 为什么选这个：rotate 的触发场景是"怀疑私钥泄露"或"到轮换周期"——两种情况下都**不该**
  让 App 无缝继续信任旧钥。invalid signature 触发的最严处置是**安全网**，强制运营方注意到
  并主动更新。自动拉 `/v1/keys` 会引入更大的攻击面（公钥分发本身也需要签名保护，套娃）。
- 为什么不选其他：见上。
- 后果：**rotate 是有副作用的操作**——所有持有旧公钥的 App 会立即进入 suspended+all 状态。
  运营方必须协调好"通知所有 App 运营方更新公钥"再 rotate，或接受一段全站 503 的窗口。
  端到端联调（2026-10-14）已实测此路径：rotate → App `signature.kind: invalid` + reason
  精确报 keyId 不匹配 → 换 pubkey 重发布 → 恢复 `verified+active`。
- 何时重新审视：如果未来引入"公钥预分发"（App 侧配多把公钥，中心用哪把签由 keyId 指示），
  可以重新审视。当前不做，因为复杂度不值得。

## ADR-014：本仓库不依赖 homura 的任何包

- 日期：2026-10
- 状态：已采纳
- 背景：`../homura` 是消费侧，`homura-genuine` 是中心。中心依赖被授权方是反向耦合——
  会让中心随消费侧的版本变动而变动。
- 考虑过的方案：
  - 中心依赖 `@homurajs/core` 拿日志/配置工具：反向耦合
  - **各持一份**：需要的类型/工具在 `contract.ts` 里各自持有
- 决策：**反向依赖禁令**。本仓库运行时依赖只有 `hono`，devDependencies 只有 tsx/typescript/
  vitest/prettier/@types/node/@hono/node-server。
- 为什么选这个：中心和消费侧的耦合点只有 `contract.ts`（且逐字一致，见 ADR-008）。
  任何额外的依赖都会让"改消费侧 → 中心跟着改"变成常态。
- 为什么不选其他：见上。
- 后果：中心侧要写一些看起来"重复"的代码（比如 logger、type guard），但换来的是**中心
  可以独立演进**。
- 何时重新审视：几乎不会。

## ADR-015：monorepo 三层布局（apps/server + apps/web + packages/contract），纯 pnpm workspaces

- 日期：2026-10-14
- 状态：已采纳
- 背景：要给授权中心加一个浏览器管理台（签发/调期/停服/轮换密钥不再靠 curl）。前端与后端
  同仓演进（管理端点形状一变，前端类型要跟着变），但二者依赖面天差地别（后端运行时只有 hono，
  前端一整套 React 生态）。单包塞不下这种分层。
- 考虑过的方案：
  - **单包 + 前端塞进 src/**：依赖混在一起，"运行时只有 hono"的哲学被前端依赖污染
  - **前端独立仓库**：管理端点类型要跨仓库同步，重演 contract.ts 的 parity 困境，不值得
  - **monorepo，统一 packages/***：apps 与 libs 语义混在一层
  - _*monorepo，apps/* + packages/_**：可部署应用（server/web）与被引用库（contract）分开
- 决策：**pnpm workspaces，`apps/server` + `apps/web` + `packages/contract` 三层**。
  不引 turbo/nx/lerna——三个包、两步构建（只 web 需要 build），workspace 协议 + `pnpm -r` 足够，
  任务图缓存的收益抵不过维护成本。根 `package.json` 是瘦编排层，用 `concurrently`+`wait-on` 起 dev。
- 为什么选这个：物理隔离前后端依赖面（ADR-014 的"运行时只有 hono"约束只落在 `apps/server` 与
  `packages/contract`，`apps/web` 是内部工具不受此约束）；契约类型放 `packages/contract` 供两侧 import，
  但**不发 npm**（见 ADR-017）；`apps/*` vs `packages/*` 的分层让"可部署"与"被引用"一眼可辨。
- 为什么不选其他：见上。参照 `../momoi` 的同构布局（apps/server + apps/web + packages/shared），
  降低在两仓库间切换的认知成本。
- 后果：新增根 `tsconfig.base.json`（solution 根 `files:[]`）、`pnpm-workspace.yaml` 的 `packages` 字段、
  4 个 `package.json`、4 个 tsconfig、根 `vitest.config.ts`（`test.projects`）。**server 保持无构建步骤**
  （prod 仍 `node --experimental-strip-types` 直跑 TS），web 产物留 `apps/web/dist`、由 server 用
  `repoRoot()` 定位托管——从而**不需要** momoi 那种"server 先 build、web 后 build"的顺序依赖。
- 何时重新审视：包数量增长到任务图缓存有实际收益时（>6 包或构建 >2 分钟），可重新评估 turbo。

## ADR-016：路径锚定仓库根（repoRoot）而非 cwd

- 日期：2026-10-14
- 状态：已采纳
- 背景：monorepo 化后 `process.cwd()` 不再等于仓库根。根脚本 `pnpm --filter @homura-genuine/server dev`
  会把 cwd 设成 `apps/server`。而 `GENUINE_DB_PATH` 的默认值原先是 `'./data/genuine.db'`（相对 cwd）。
- 考虑过的方案：
  - 保持 cwd 相对，文档里要求"必须在仓库根运行"：脆弱，`pnpm --filter` 天然违反
  - 默认值写死绝对路径：不可移植
  - **锚定仓库根**：新增 `repoRoot()`，相对路径一律 resolve 到它
- 决策：新增 `apps/server/src/paths.ts` 的 `repoRoot()`——从 `import.meta.url` 逐级向上找含
  `pnpm-workspace.yaml` 的目录，找不到兜底 `process.cwd()`（裸 dist 部署时行为不变）。`env.ts` 里
  `GENUINE_DB_PATH` 的**默认值与显式相对值都过 repoRoot**；`:memory:` 与绝对路径原样透传。
- 为什么选这个：不锚定的后果是 `pnpm --filter` 下 cwd=apps/server，会在 `apps/server/data/` **新建一个空库**，
  而根 `data/genuine.db`（含真实授权与签名私钥）被晾在一边——表现为"授权数据全丢了、密钥也变了"，
  极难排查。`pnpm-workspace.yaml` 是天然的仓库根标记（照抄 momoi 的 `paths.ts`）。
- 为什么不选其他：文档约束挡不住工具链的 cwd 行为；绝对路径不可移植。
- 后果：`data/`、web 产物 `apps/web/dist`、对端契约路径全部经 repoRoot 解析。`.gitignore` 的 `data/`
  改成根锚定 `/data/`——这样万一锚定失效、误建了 `apps/server/data/`，其 `*.db-shm/*.db-wal` 会暴露在
  `git status` 里，成为第二道告警（`*.db` 仍宽匹配兜底，任何位置的库文件都绝不进版本库）。
- 何时重新审视：几乎不会。这是 monorepo 的基本卫生。

## ADR-017：contract.ts 移入 packages/contract 但逐字不改、不拆包、不发 npm；admin.ts 不纳入 parity

- 日期：2026-10-14
- 状态：已采纳
- 背景：ADR-008 否决过"把契约抽成第三方 npm 包"（理由：会给 App 产物加外部依赖 + 版本管理复杂）。
  monorepo 化后前端也要复用契约类型，自然会想"那是不是该抽包了"。同时管理端点的类型
  （ProductRow、describe() 视图）原先散在 `db.ts`/`service.ts`，前端拿不到。
- 考虑过的方案：
  - 把 contract.ts 发成 npm 包：违反 ADR-008（App 产物多一个外部依赖）
  - 前端复制一份 admin 类型：后端改 describe() 字段时前端不报错，隐式漂移
  - **monorepo 内部 workspace 包**：`packages/contract` 零构建源码直引，不发 npm
- 决策：`packages/contract` 用 **exports 指向 `./src/*.ts`**（零构建，server 由 Node 类型擦除直读、
  web 由 Vite 原生消费）。`contract.ts` **逐字不改**搬入（parity 仍守，仍与 ../homura 一致）。
  新增 `admin.ts` 承载管理端点类型——它是**中心内部契约**，App 侧永不调 `/admin/*`，
  故**不纳入 parity 比对**、可自由演进。
- 为什么选这个：workspace 包只在本仓库内被 `workspace:*` 引用，**不发布、不给任何派生 App 加依赖**，
  与 ADR-008 否决的"第三方 npm 包"是两回事——那条否决的是"让分发出去的 App 产物背一个外部依赖"，
  本决策不触碰这个前提。`admin.ts` 只允许 `import type` 引用 contract.ts（禁 `export *`、禁 re-export
  运行值）：否则 web 侧 import admin.ts 会把 contract.ts 顶部的 `node:crypto` 拖进浏览器 bundle，
  而 Vite 对此只报 warning 不失败、运行时才白屏。用一条守卫测试（admin.test.ts 扫源码文本）把这条
  静默泄漏路径变成硬失败。
- 为什么不选其他：npm 包违反 ADR-008；前端复制类型会漂移。
- 后果：`packages/contract/src/contract.ts` 列入 `.prettierignore`（字节形态归同步协议管，formatter
  的 `endOfLine:lf` 会破坏字节级 parity——此坑在 `pnpm format` 后 parity 当场抓到）。parity 测试的
  PEER 相对路径因文件下沉两级而改层级（退三级到仓库根再 `../homura`），并把 skip 判据从"对端**文件**存在"
  改成"对端**仓库**存在"：仓库在而文件不在 = 路径算错 = **显式失败**，杜绝"层级写错→静默 skip→门禁形同虚设"。
- 何时重新审视：若消费侧 ../homura 也迁进同一 monorepo，contract 可改为真正的内部共享包、免掉 cp 同步。

## ADR-018：同源托管 web 产物 + 手写静态中间件（不用 @hono/node-server/serve-static）

- 日期：2026-10-14
- 状态：已采纳
- 背景：管理台要部署。前后端分离部署需要后端开 CORS、前端另找静态托管、还要处理跨域凭据；
  同源托管则单进程单端口、无跨域。
- 考虑过的方案：
  - **完全分离**：前端独立部署 + 后端 CORS
  - **同源托管**：server 挂 web 的 dist + SPA fallback
  - 用 `@hono/node-server/serve-static`：现成，但有已知坑
- 决策：**同源托管**。`buildApp({ webRoot? })` 在传了 webRoot 时挂一个**手写**的静态中间件
  （`apps/server/src/static.ts`），注册在所有 API 路由之后、`app.notFound` 之前；webRoot 缺省时
  **完全不挂**（现有"未知路径→JSON 404"测试零回归）。不用 `@hono/node-server/serve-static`。
- 为什么选这个：授权中心是单人运营的内部服务，同源托管省去 CORS 与二次部署，单端口即可对外。
  手写中间件规避 `@hono/node-server/serve-static` 的 **tsx#623**——该子路径模块在 Windows +
  stdout 是管道（根脚本 concurrently 下）时会让 `tsx watch` **挂死**，而本服务 dev 正是这个组合
  （momoi 的 D15 记录并踩过同一坑，照抄其手写方案）。三条不可省的规则：① API 前缀 `/healthz|/v1|/admin`
  豁免（否则 App 打错的端点会被 SPA fallback 吞成 200+HTML，App 拿 HTML 当授权响应解析→静默误判）；
  ② 仅 GET/HEAD；③ 路径穿越防护。Hono 的 `app.use('*')` 注册在路由后只接未匹配路径（读 compose.js +
  hono-base.js 源码确认），配合前缀豁免，API 的 404 仍是 JSON。
- 为什么不选其他：分离部署对一个内部单服务是过度设计；serve-static 有实测挂死风险。
- 后果：`pnpm build` 只构建 web；server 无构建步骤，prod 用 `repoRoot()/apps/web/dist` 定位产物，
  目录不存在则告警但不崩溃（开发期没 build 也能起服务，只是 `/` 返回 JSON 404）。
- 何时重新审视：若管理台需要独立灰度/CDN 分发，可拆成分离部署。

## ADR-019：管理台复用 GENUINE_ADMIN_TOKEN + sessionStorage，不建独立会话体系

- 日期：2026-10-14
- 状态：已采纳
- 背景：管理台要登录。后端 `/admin/*` 已有 bearer 鉴权（`GENUINE_ADMIN_TOKEN`）。前端要不要另建
  一套会话（登录换 JWT、cookie、刷新续期）？
- 考虑过的方案：
  - 后端加登录端点签发 JWT + HttpOnly cookie（momoi 那套）：要引入会话存储、续期、失效
  - 纯内存存 token：刷新页面就丢，体验差
  - localStorage 存 token：长期留磁盘，共享机器风险高
  - **sessionStorage 存 GENUINE_ADMIN_TOKEN**：关标签页即清，刷新当前标签页不用重登
- 决策：**前端直接持有 `GENUINE_ADMIN_TOKEN`，存 sessionStorage**，每次请求注入 `Authorization: Bearer`。
  登录页用 `GET /admin/products` 做探针验证 token 有效性，成功才落库。**不新增任何后端会话端点**。
- 为什么选这个：授权中心是单人运营的内部工具，`GENUINE_ADMIN_TOKEN` 本就是"管理即一切"的根凭据，
  再套一层会话体系是过度设计（要多维护登录/续期/失效逻辑，且根凭据仍在）。sessionStorage 是安全与
  体验的折中：比 localStorage 少了长期磁盘留存，比纯内存多了"刷新不掉线"。前端严格区分 401 与 503——
  503 = 服务端未配 token（管理接口整体禁用，不清会话、提示配置问题）；401 = token 无效（登录页内联报错，
  其他页清会话跳登录）。复刻 momoi 的"陈旧 401"防护（登录前发出的旧请求返回的 401 不能踢掉新会话）
  与登出 1 秒节流。
- 为什么不选其他：JWT/cookie 方案对一个单凭据内部工具是纯增复杂度；纯内存/localStorage 各有体验或安全短板。
- 后果：token 在 sessionStorage 里对同源 JS 可见（XSS 可读）——但本管理台无第三方脚本、无用户内容渲染，
  XSS 面极小；且 token 本就是根凭据，持有者即可管理，多一层会话不改变这个事实。**绝不**用 localStorage。
- 何时重新审视：若管理台要开放给多角色运营（需要区分权限、审计到人），则需引入独立身份体系
  （对接 `../oauth2-dingtalk`），届时本决策作废。
