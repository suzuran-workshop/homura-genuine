/**
 * 管理台布局外壳：左侧导航 + 顶部栏（标题 + 登出）+ 内容区（Outlet）。
 * 用 NavLink 高亮当前路由。深色模式跟随系统（见 main.tsx 里给 <html> 加 .dark）。
 */
import { KeyRound, LayoutDashboard, LogOut, Package, ShieldCheck } from 'lucide-react'
import { NavLink, Outlet } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useSession } from '@/lib/session'

const NAV = [
  { to: '/', label: '总览', icon: LayoutDashboard, end: true },
  { to: '/licenses', label: '授权', icon: ShieldCheck, end: false },
  { to: '/products', label: '产品', icon: Package, end: false },
  { to: '/keys', label: '签名密钥', icon: KeyRound, end: false },
]

export function AppLayout() {
  const { logout } = useSession()

  return (
    <div className="flex min-h-screen bg-muted/30">
      {/* 侧边导航 */}
      <aside className="sticky top-0 flex h-screen w-56 shrink-0 flex-col border-r bg-background">
        <div className="flex h-14 items-center gap-2 border-b px-4">
          <ShieldCheck className="size-5 text-primary" />
          <span className="font-semibold tracking-tight">homura-genuine</span>
        </div>
        <nav className="flex-1 space-y-1 p-3">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink key={to} to={to} end={end} className="block">
              {({ isActive }) => (
                <span
                  className={cn(
                    'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                  )}
                >
                  <Icon className="size-4" />
                  {label}
                </span>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="border-t p-3">
          <Button
            variant="ghost"
            className="w-full justify-start gap-2 text-muted-foreground"
            onClick={logout}
          >
            <LogOut className="size-4" />
            退出登录
          </Button>
        </div>
      </aside>

      {/* 内容区 */}
      <main className="min-w-0 flex-1">
        <div className="mx-auto max-w-6xl p-6">
          <Outlet />
        </div>
      </main>
    </div>
  )
}
