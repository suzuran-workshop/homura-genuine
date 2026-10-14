/**
 * 会话 context：管理台的登录态编排。
 *
 * - token 存 sessionStorage（见 lib/auth.ts），刷新当前标签页不用重登、关标签页即清除
 * - tryLogin(token)：用 GET /admin/products 做探针验证 token；成功才落库 + markLogin
 *   （markLogin 记录登录时刻，配合 api.ts 的 isStaleAuth 挡掉「登录前发出的旧请求 401」）
 * - 监听全局 genuine:unauthorized 事件（api.ts 在非陈旧 401 时派发）→ 自动登出跳登录页，
 *   并做 1 秒节流防并发风暴（复刻 momoi 的踩坑经验）
 *
 * SessionProvider 必须在 Router 内部（用了 useNavigate）。
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { clearToken, getToken, markLogin, setToken } from './auth.ts'
import { ApiError, createApi } from './api.ts'

export type LoginResult = { ok: true } | { ok: false; message: string }

interface Session {
  /** 当前是否已登录（有 token） */
  authed: boolean
  /** 用候选 token 做探针验证；成功则落库并置为已登录 */
  tryLogin: (token: string) => Promise<LoginResult>
  /** 主动登出：清 token 并跳登录页 */
  logout: () => void
}

const SessionContext = createContext<Session | null>(null)

export function useSession(): Session {
  const ctx = useContext(SessionContext)
  if (!ctx) throw new Error('useSession 必须在 SessionProvider 内使用')
  return ctx
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [authed, setAuthed] = useState<boolean>(() => getToken() !== null)
  const navigate = useNavigate()
  const lastLogoutRef = useRef(0)

  const logout = useCallback(() => {
    // 1 秒节流：并发 401 只处理一次
    const now = Date.now()
    if (now - lastLogoutRef.current < 1000) return
    lastLogoutRef.current = now
    clearToken()
    setAuthed(false)
    navigate('/login', { replace: true })
  }, [navigate])

  // 监听 api.ts 派发的未授权事件（token 失效 / 服务端换 token 等）
  useEffect(() => {
    const onUnauthorized = () => logout()
    window.addEventListener('genuine:unauthorized', onUnauthorized)
    return () => window.removeEventListener('genuine:unauthorized', onUnauthorized)
  }, [logout])

  const tryLogin = useCallback(async (token: string): Promise<LoginResult> => {
    const trimmed = token.trim()
    if (!trimmed) return { ok: false, message: '请输入管理密钥' }
    // 探针：用候选 token 建临时 api 实例，不带 onUnauthorized（登录页的 401 只内联报错，不触发跳转）
    const probe = createApi({ getToken: () => trimmed })
    try {
      await probe.listProducts()
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.kind === 'unauthorized') return { ok: false, message: '管理密钥无效（401）' }
        if (err.kind === 'admin-disabled') {
          return { ok: false, message: '服务端未配置 GENUINE_ADMIN_TOKEN，管理接口整体禁用（503）' }
        }
        if (err.kind === 'network')
          return { ok: false, message: '无法连接服务端，请确认后端已启动' }
        return { ok: false, message: err.message }
      }
      return { ok: false, message: '登录失败：未知错误' }
    }
    setToken(trimmed)
    markLogin()
    setAuthed(true)
    return { ok: true }
  }, [])

  return (
    <SessionContext.Provider value={{ authed, tryLogin, logout }}>
      {children}
    </SessionContext.Provider>
  )
}
