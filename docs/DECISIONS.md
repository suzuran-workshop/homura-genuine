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
