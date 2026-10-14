/**
 * 路由骨架。同源托管已支持 SPA fallback（server 的 static.ts），故 deep link 直接可用。
 *
 * 结构：
 *   /login        公开
 *   （RequireAuth 守卫）
 *     /           总览        AppLayout 外壳
 *     /licenses   授权列表
 *     /licenses/new  签发
 *     /licenses/:id  详情编辑
 *     /products   产品管理
 *     /keys       签名密钥
 *
 * SessionProvider 在 BrowserRouter 内部（它用 useNavigate）。
 */
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { Toaster } from '@/components/ui/sonner'
import { AppLayout } from '@/components/AppLayout'
import { RequireAuth } from '@/components/RequireAuth'
import { SessionProvider } from '@/lib/session'
import { LoginPage } from '@/pages/LoginPage'
import { OverviewPage } from '@/pages/OverviewPage'
import { LicensesPage } from '@/pages/LicensesPage'
import { LicenseNewPage } from '@/pages/LicenseNewPage'
import { LicenseDetailPage } from '@/pages/LicenseDetailPage'
import { ProductsPage } from '@/pages/ProductsPage'
import { KeysPage } from '@/pages/KeysPage'

export default function App() {
  return (
    <BrowserRouter>
      <SessionProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route element={<RequireAuth />}>
            <Route element={<AppLayout />}>
              <Route path="/" element={<OverviewPage />} />
              <Route path="/licenses" element={<LicensesPage />} />
              <Route path="/licenses/new" element={<LicenseNewPage />} />
              <Route path="/licenses/:id" element={<LicenseDetailPage />} />
              <Route path="/products" element={<ProductsPage />} />
              <Route path="/keys" element={<KeysPage />} />
            </Route>
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        <Toaster position="top-right" richColors closeButton />
      </SessionProvider>
    </BrowserRouter>
  )
}
