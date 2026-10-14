/**
 * 管理密钥（GENUINE_ADMIN_TOKEN）的浏览器侧会话管理。
 *
 * 存 sessionStorage 而非 localStorage：关标签页即清除，刷新当前标签页不用重登。
 * 密钥是「中心管理员令牌」，泄露面越小越好；不用 localStorage 是因为它会长期留在磁盘、
 * 共享机器上风险最高。也不用纯内存是因为刷新就丢、体验太差。
 */
const TOKEN_KEY = 'genuine.admin.token'

export function getToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function setToken(token: string): void {
  sessionStorage.setItem(TOKEN_KEY, token)
}

export function clearToken(): void {
  sessionStorage.removeItem(TOKEN_KEY)
}

/**
 * 「陈旧 401」防护（复刻 momoi 的踩坑经验）：
 *
 * 登录页会先用探针请求验证 token；若用户此前发起的、携带旧 token 的请求在**新登录之后**
 * 才返回 401，这个 401 描述的是旧会话，不该把刚建立的新会话踢掉。做法是记录每次登录的时刻，
 * 收到 401 时比较「请求发起时刻」与「最近登录时刻」，早于登录的 401 一律丢弃。
 */
let lastLoginAt = 0

/** 记录登录时刻。at 可注入（测试用固定值，避免依赖真实时钟）。 */
export function markLogin(at: number = Date.now()): void {
  lastLoginAt = at
}

/** 请求发起时刻 startedAt 是否早于最近一次登录（是则该 401 陈旧，应丢弃） */
export function isStaleAuth(startedAt: number): boolean {
  return startedAt < lastLoginAt
}
