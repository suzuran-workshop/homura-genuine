/**
 * 路由守卫：未登录跳 /login，已登录放行。
 * 登录态以 sessionStorage 是否有 token 为准（见 useSession）。
 */
import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useSession } from '@/lib/session'

export function RequireAuth() {
  const { authed } = useSession()
  const location = useLocation()
  if (!authed) {
    // 记住来路，登录后跳回（state 传给 login 页）
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }
  return <Outlet />
}
