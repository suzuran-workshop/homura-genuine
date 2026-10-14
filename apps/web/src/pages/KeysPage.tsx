/**
 * 签名密钥页：列表（keyId、公钥 PEM 可复制、createdAt、retired）+ 轮换。
 *
 * ⚠ 轮换是重操作（ADR-013）：旧钥退休（历史签名仍可用旧公钥验），新钥成为签发用，
 *   **App 侧必须同步更新配置的公钥**，否则新签发的授权验不过。故二次确认 + 显眼警告。
 * ⚠ 只展示公钥与 keyId；私钥后端从不下发（AGENTS.md 硬规则）。
 */
import { useState } from 'react'
import { Check, Copy, KeyRound, RefreshCw, RotateCcw, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { api, ApiError } from '@/lib/api'
import { useAction, useQuery } from '@/hooks/useApi'
import { formatDateTime } from '@/lib/format'

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error('复制失败，请手动选择文本')
    }
  }
  return (
    <Button variant="outline" size="sm" onClick={copy}>
      {copied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
      {copied ? '已复制' : '复制公钥'}
    </Button>
  )
}

export function KeysPage() {
  const keys = useQuery(() => api.listKeys(), [])
  const [confirmOpen, setConfirmOpen] = useState(false)

  const rotate = useAction(
    () => api.rotateKey(),
    (r) => {
      toast.success(`已轮换，新 keyId=${r.keyId}；记得更新 App 侧公钥`)
      setConfirmOpen(false)
      void keys.refresh()
    },
  )

  const activeKey = keys.data?.find((k) => !k.retired) ?? null
  const retiredKeys = keys.data?.filter((k) => k.retired) ?? []

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">签名密钥</h1>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => keys.refresh()}>
            <RefreshCw className="size-4" />
            刷新
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setConfirmOpen(true)}
            disabled={rotate.pending}
          >
            <RotateCcw className="size-4" />
            轮换密钥
          </Button>
        </div>
      </div>

      <Alert className="border-amber-500/40 bg-amber-500/10">
        <TriangleAlert className="size-4 text-amber-600 dark:text-amber-400" />
        <AlertDescription className="text-amber-800 dark:text-amber-200">
          私钥永不出中心（后端从不下发）。启动日志与本页只给公钥与 keyId。App 侧把公钥配到
          <code className="mx-1 rounded bg-black/10 px-1">GENUINE_PUBLIC_KEY</code>
          验签；轮换后必须同步更新，否则新授权验不过。
        </AlertDescription>
      </Alert>

      {keys.error && (
        <Alert variant="destructive">
          <AlertDescription>{keys.error.message}</AlertDescription>
        </Alert>
      )}

      {keys.loading ? (
        <Skeleton className="h-40" />
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <KeyRound className="size-4" />
                当前签发密钥
              </CardTitle>
            </CardHeader>
            <CardContent>
              {activeKey ? (
                <div className="space-y-3">
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-sm">keyId: {activeKey.keyId}</span>
                    <Badge variant="default">签发中</Badge>
                    {activeKey.createdAt && (
                      <span className="text-xs text-muted-foreground">
                        创建于 {formatDateTime(activeKey.createdAt)}
                      </span>
                    )}
                  </div>
                  <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">
                    {activeKey.publicKey.trim()}
                  </pre>
                  <CopyButton text={activeKey.publicKey.trim()} />
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  尚无活跃密钥（服务首次启动会自动生成一把）。
                </p>
              )}
            </CardContent>
          </Card>

          {retiredKeys.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">已退休密钥（仍可验历史签名）</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {retiredKeys.map((k) => (
                  <div key={k.keyId} className="rounded-md border p-3">
                    <div className="flex items-center gap-3">
                      <span className="font-mono text-sm">keyId: {k.keyId}</span>
                      <Badge variant="outline">retired</Badge>
                      {k.createdAt && (
                        <span className="text-xs text-muted-foreground">
                          创建于 {formatDateTime(k.createdAt)}
                        </span>
                      )}
                    </div>
                    <pre className="mt-2 overflow-x-auto rounded bg-muted p-2 font-mono text-xs opacity-70">
                      {k.publicKey.trim()}
                    </pre>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </>
      )}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <TriangleAlert className="size-5 text-destructive" />
              确认轮换签名密钥？
            </AlertDialogTitle>
            <AlertDialogDescription className="space-y-2">
              <span>
                轮换会立即生成一把新密钥用于签发，当前密钥退休（历史签名仍可用旧公钥验）。
              </span>
              <span className="block font-medium text-destructive">
                ⚠ 所有 App 实例必须更新配置的 GENUINE_PUBLIC_KEY，否则此后新签发的授权会验签失败
                （表现为 keyId 不匹配 → 中心已轮换密钥）。这是一次需要协调全部消费侧的运维动作。
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault() // 阻止默认关闭，交由 useAction 成功后关
                rotate.run().catch((err: ApiError) => toast.error(err.message))
              }}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {rotate.pending ? '轮换中…' : '确认轮换'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
