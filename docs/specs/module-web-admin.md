# Spec — 管理台（apps/web）

## 要构建什么

- 目标：给中心运营方一个浏览器管理台，覆盖 `/admin/*` 的全部运营动作（产品、授权签发/调整、
  密钥轮换），不再靠 curl。同源托管于 server（ADR-018），登录复用 `GENUINE_ADMIN_TOKEN`（ADR-019）。
- 边界：管理台是**内部运营工具**，只调 `/admin/*` 与只读的 `/v1/keys`、`/healthz`；
  **绝不**调 `/v1/register`、`/v1/heartbeat`（那是 App 侧的契约端点）。

## 行为

### 鉴权流程

```
登录页输入 token
  → createApi({ getToken: () => 候选token }).listProducts()   // 探针
  → 200：setToken(sessionStorage) + markLogin() + 跳回原页面
  → 401：内联报错「管理密钥无效」（不触发全局登出，因为此刻还没有会话）
  → 503：内联报错「服务端未配置 GENUINE_ADMIN_TOKEN，管理接口整体禁用」
  → 网络失败：内联报错「无法连接服务端」
```

**关键点**：

- 探针用 `GET /admin/products`（最轻的已鉴权端点）。登录页的探针实例**不挂 onUnauthorized**，
  故 401 只内联报错，不会误触发"登出"逻辑。
- token 存 **sessionStorage**（键 `genuine.admin.token`）：关标签页即清除，刷新当前标签页不用重登。
  **绝不**用 localStorage（长期磁盘留存，共享机器风险高）。

### 401 / 503 分流

| 状态              | 含义                                               | 前端行为                                                                           |
| ----------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 503               | 服务端未配 `GENUINE_ADMIN_TOKEN`，管理接口整体禁用 | **不清会话**，提示"服务端未启用管理接口"。清会话无意义——问题在服务端配置           |
| 401               | bearer token 无效                                  | 登录页：内联报错。其他页：清 sessionStorage + 广播 `genuine:unauthorized` → 跳登录 |
| 404               | `license_not_found` / `product_not_found`          | 就地展示错误，不动会话                                                             |
| 400               | `bad_request`                                      | 表单校验提示                                                                       |
| 0（fetch reject） | 网络不可达                                         | 提示"无法连接服务端"                                                               |

### 陈旧 401 防护（复刻 momoi 踩坑）

场景：用户在登录页停留时，某个携带**旧 token** 的请求已在飞行中；用户完成登录（新 token 落库）后，
那个旧请求才返回 401。若照单全收，会把刚建立的新会话踢回登录页（"登录后立刻被登出"）。

```
登录成功 → markLogin(t)         // 记录登录时刻
收到 401（请求发起于 startedAt）
  → isStaleAuth(startedAt) = startedAt < t ?
    → true：丢弃（陈旧，描述的是旧会话）
    → false：真失效，清会话 + 跳登录（1 秒节流防并发风暴）
```

- `lib/auth.ts` 的 `markLogin(at = Date.now())` 支持时间注入（测试用固定值，不依赖真实时钟）。
- 登出广播（`window` 的 `genuine:unauthorized` 事件）由 `SessionProvider` 统一监听，做 1 秒节流。

### 页面清单

| 路由            | 页面     | 覆盖端点                                                         | 要点                                                                                                     |
| --------------- | -------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `/login`        | 登录     | `GET /admin/products`（探针）                                    | 见上「鉴权流程」                                                                                         |
| `/`             | 总览     | `GET /healthz` `/admin/products` `/admin/licenses` `/admin/keys` | 产品/授权/密钥计数、有效状态分布、当前 keyId、最近活跃                                                   |
| `/licenses`     | 授权列表 | `GET /admin/licenses?productId=&appId=`                          | 过滤、行内快捷（+90d / 停服 / 恢复）走 `PATCH`                                                           |
| `/licenses/new` | 签发     | `POST /admin/licenses`                                           | 到期三选一（N 天 / 具体日期 / 永不过期）；enforcement/features/notice/心跳/宽限可选，留空用产品默认      |
| `/licenses/:id` | 详情编辑 | `GET` + `PATCH /admin/licenses/:id`                              | PATCH 语义：不改的字段**不发送**（undefined）；`expiresAt:null`=永不过期；`notice:null`=清空回落自动生成 |
| `/products`     | 产品管理 | `GET /admin/products`、`PUT /admin/products/:id`                 | `allowSelfRegister` 开关须传**真 boolean**；开启时显眼警示"= 放弃实例管控"（ADR-007）                    |
| `/keys`         | 签名密钥 | `GET /admin/keys`、`POST /admin/keys/rotate`                     | 公钥 PEM 可复制；轮换需二次确认 + ADR-013 警告（App 侧必须更新公钥）                                     |

### 类型来源

- 前端所有管理端点类型来自 `@homura-genuine/contract/admin`（`AdminProduct`、`AdminLicense`、
  `AdminKey`、各 Body 与响应信封），**只 `import type`**——不引 contract.ts 的运行值，
  否则 `node:crypto` 会进 bundle（见 ADR-017）。
- `Enforcement`、`LicenseStatus` 这两个纯类型也从 contract 的 `import type` 取。

## 约束

- **密钥材料永不显示**：licenseKey 原文、私钥后端从不回吐，前端也不得从别处拼接展示。
  公钥 PEM 与 keyId 可自由展示/复制。
- **不引入数据请求库**（tanstack-query 等）：用 `hooks/useApi.ts` 的 `useQuery`/`useAction` 轻封装
  （裸 fetch），符合本仓库极简哲学。
- **api 客户端可注入**：`createApi({ fetchImpl, getToken, onUnauthorized, now })`，测试传 stub、
  走 node 环境，不装 jsdom。
- **web 依赖不污染 server**：React 生态依赖只存在于 `apps/web/package.json`（ADR-014/015）。

## 边界条件

- 服务端未配 token（503）：登录页提示配置问题，**不清空**已输入的 token（用户可能填对了，是服务端没配）。
- 已登录但服务端重启后换了 token：下一个请求 401 → 清会话跳登录。
- 列表为空：各页展示引导文案（"去建产品"/"去签发"），不是空白表格。
- `expiresAt: null`（永不过期）：详情页到期区显示"永不过期"，编辑时可选"设为具体日期"改回有限期。
- `enforcement` 在 `effectiveStatus === 'active'` 时禁改（后端 active 恒下发 none，改了也无意义）。
- features 输入支持逗号或空格分隔，前端去重去空后再提交。
- 直接访问深链（如刷新 `/licenses/:id`）：server 的 SPA fallback 返回 index.html，react-router 接管。
- 拼错的 API 路径（如 `/admin/nope`）：**不**被 SPA fallback 吞成 HTML，仍返回 JSON 404（见 static.ts 前缀豁免）。

## 验收标准

分三层如实标注验证方式：`[x]` 自动化 = 有测试/构建守卫兜底；`[x]` HTTP = 对真实服务跑通
（UI 每个按钮背后的 HTTP 操作）；`[ ]` 人工 = 需浏览器点验，尚未做。

**已自动化验证（测试 / 构建守卫）**

- [x] `pnpm --filter @homura-genuine/web build` 产物落 `apps/web/dist`（实测 vite 8.3.4 构建通过，1690 模块）
- [x] 构建产物 grep `node:crypto` / `createPublicKey` **零命中**（契约运行值未泄漏进 bundle；
      另有 `packages/contract/src/admin.test.ts` 源码级守卫，双保险）
- [x] `pnpm --filter @homura-genuine/web test`：api 的 401/503/陈旧/网络分流、解包、查询串、
      Bearer 注入全绿（12 项，注入 stub fetch 走 node 环境，不装 jsdom）
- [x] 三包 `pnpm typecheck` 全绿；`pnpm test` 全量 84 项通过、parity 用例 executed 非 skipped

**已 HTTP 端到端验证（对真实 node 服务，覆盖 UI 全部写操作）**

- [x] `pnpm build && pnpm start` 后 `:8787/` 返回 SPA index.html（`<title>homura-genuine · 授权管理台</title>`）
- [x] 深链 `/licenses` 刷新返回 index.html（200，非 404）；拼错的 `/v1/nope`、`/admin/nope` 仍 JSON 404（前缀豁免生效）
- [x] 未鉴权 `/admin/products` → 401（不被 SPA 吞成 HTML）；未配 token → 整体 503
- [x] 建产品 → 签发授权 → 列表过滤可见 → 改到期(expiresInDays) → 停服(status/enforcement) →
      改 features/notice → 恢复 active → 轮换密钥，全链路 HTTP 跑通（详见提交验证记录）
- [x] `describeProduct` 干净形状：`allowSelfRegister` 是真 boolean、`defaultFeatures` 是真数组
- [x] 列表/详情响应**不回显** licenseKey 原文；密钥端点**只给公钥不含私钥**
- [x] 中文 notice/appId 存取完好（用 Node fetch 以 UTF-8 验证；curl 在 Git Bash 传中文会按 GBK 乱码，是工具锅非应用 bug）
- [x] repoRoot 锚定：`pnpm --filter` 下 db 仍指向仓库根 `data/genuine.db`，未在 `apps/server/data/` 误建空库
- [x] dev 模式 `tsx watch` 在 Windows 下完整启动到 listening、不挂死（规避 tsx#623）

**需人工浏览器验证（尚未做——本机无浏览器自动化环境）**

- [ ] 错 token 登录 → 登录页内联报错且不跳转；对 token → 进总览（api 分流逻辑已单测，但未在真实浏览器点验）
- [ ] 服务端不配 token → 登录页提示"管理接口整体禁用"（503），不清空输入
- [ ] 陈旧 401 防护在真实登录时序下的表现（逻辑已单测）
- [ ] 各页面表单交互、toast 提示、深色模式、移动端布局的视觉与可用性
