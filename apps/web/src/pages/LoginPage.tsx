/**
 * 登录页：输入 GENUINE_ADMIN_TOKEN，用 GET /admin/products 做探针验证。
 * 成功后落 sessionStorage 并跳回原页面（或总览）。401 内联报错，不触发全局登出。
 */
import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Loader2, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { useSession } from '@/lib/session'

export function LoginPage() {
  const { tryLogin } = useSession()
  const navigate = useNavigate()
  const location = useLocation()
  const from = (location.state as { from?: string } | null)?.from ?? '/'

  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const result = await tryLogin(token)
    setBusy(false)
    if (result.ok) {
      navigate(from, { replace: true })
    } else {
      setError(result.message)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex size-12 items-center justify-center rounded-full bg-primary/10">
            <ShieldCheck className="size-6 text-primary" />
          </div>
          <CardTitle className="text-xl">homura-genuine 授权管理台</CardTitle>
          <CardDescription>
            输入服务端配置的管理密钥（
            <code className="rounded bg-muted px-1">GENUINE_ADMIN_TOKEN</code>）
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="token">管理密钥</Label>
              <Input
                id="token"
                type="password"
                autoComplete="current-password"
                placeholder="Bearer token"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                autoFocus
              />
            </div>

            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <Button type="submit" className="w-full" disabled={busy || !token.trim()}>
              {busy && <Loader2 className="size-4 animate-spin" />}
              {busy ? '验证中…' : '登录'}
            </Button>

            <p className="text-center text-xs text-muted-foreground">
              密钥仅存于本标签页会话（sessionStorage），关闭标签页即清除。
            </p>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
