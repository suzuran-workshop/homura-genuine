/**
 * 签发授权页：productId/appId/licenseKey/到期/enforcement/features/notice/心跳/宽限。
 * 到期方式三选一：N 天后（expiresInDays）/ 具体日期（expiresAt ISO）/ 永不过期（expiresAt null）。
 * 后端 POST /admin/licenses 会按产品默认值兜底未填项。
 */
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { api, ApiError } from '@/lib/api'
import { useAction, useQuery } from '@/hooks/useApi'
import { ENFORCEMENTS, ENFORCEMENT_INFO } from '@/lib/format'
import type { Enforcement } from '@homura-genuine/contract/contract'

type ExpiryMode = 'days' | 'date' | 'never'

/** 逗号/空格分隔文本 → 去重去空的字符串数组 */
function parseFeatures(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ]
}

export function LicenseNewPage() {
  const navigate = useNavigate()
  const products = useQuery(() => api.listProducts(), [])

  const [productId, setProductId] = useState('')
  const [appId, setAppId] = useState('')
  const [licenseKey, setLicenseKey] = useState('')
  const [expiryMode, setExpiryMode] = useState<ExpiryMode>('days')
  const [days, setDays] = useState('365')
  const [date, setDate] = useState('')
  const [enforcement, setEnforcement] = useState<Enforcement | ''>('')
  const [features, setFeatures] = useState('')
  const [notice, setNotice] = useState('')
  const [heartbeat, setHeartbeat] = useState('')
  const [grace, setGrace] = useState('')

  const issue = useAction(
    () => api.issueLicense(buildBody()),
    (l) => {
      toast.success('已签发授权')
      navigate(`/licenses/${l.licenseId}`)
    },
  )

  function buildBody() {
    const body: Parameters<typeof api.issueLicense>[0] = { productId, appId }
    if (licenseKey.trim()) body.licenseKey = licenseKey.trim()
    if (expiryMode === 'days') body.expiresInDays = Number(days)
    else if (expiryMode === 'date') body.expiresAt = new Date(`${date}T00:00:00`).toISOString()
    else body.expiresAt = null
    if (enforcement) body.enforcement = enforcement
    if (features.trim()) body.features = parseFeatures(features)
    if (notice.trim()) body.notice = notice.trim()
    if (heartbeat.trim()) body.heartbeatIntervalSec = Number(heartbeat)
    if (grace.trim()) body.graceSec = Number(grace)
    return body
  }

  const canSubmit =
    !!productId &&
    !!appId.trim() &&
    (expiryMode !== 'date' || !!date) &&
    (expiryMode !== 'days' || !!days)

  function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    issue.run().catch((err: ApiError) => toast.error(err.message))
  }

  if (products.error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{products.error.message}</AlertDescription>
      </Alert>
    )
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <h1 className="text-2xl font-bold tracking-tight">签发授权</h1>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">基本信息</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="productId">产品 *</Label>
            {products.loading ? (
              <div className="text-sm text-muted-foreground">加载中…</div>
            ) : !products.data?.length ? (
              <Alert>
                <AlertDescription>
                  还没有产品，先去{' '}
                  <Link to="/products" className="underline">
                    建一个
                  </Link>
                  。
                </AlertDescription>
              </Alert>
            ) : (
              <Select value={productId} onValueChange={setProductId}>
                <SelectTrigger id="productId">
                  <SelectValue placeholder="选择产品" />
                </SelectTrigger>
                <SelectContent>
                  {products.data.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}（{p.id}）
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="appId">appId *</Label>
            <Input
              id="appId"
              placeholder="如 app-1"
              value={appId}
              onChange={(e) => setAppId(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="licenseKey">licenseKey（可选）</Label>
            <Input
              id="licenseKey"
              placeholder="预签发场景填；留空则该授权不走 licenseKey 校验"
              value={licenseKey}
              onChange={(e) => setLicenseKey(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              填了 licenseKey 的授权，App 首次注册须携带它；换实例复用会撞
              instance_mismatch（403），即盗用信号。
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">有效期</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2">
            {(
              [
                ['days', 'N 天后'],
                ['date', '具体日期'],
                ['never', '永不过期'],
              ] as [ExpiryMode, string][]
            ).map(([mode, label]) => (
              <Button
                key={mode}
                type="button"
                size="sm"
                variant={expiryMode === mode ? 'default' : 'outline'}
                onClick={() => setExpiryMode(mode)}
              >
                {label}
              </Button>
            ))}
          </div>
          {expiryMode === 'days' && (
            <div className="space-y-2">
              <Label htmlFor="days">有效天数</Label>
              <Input
                id="days"
                type="number"
                min={1}
                value={days}
                onChange={(e) => setDays(e.target.value)}
              />
            </div>
          )}
          {expiryMode === 'date' && (
            <div className="space-y-2">
              <Label htmlFor="date">到期日期</Label>
              <Input id="date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
          )}
          {expiryMode === 'never' && (
            <p className="text-sm text-muted-foreground">该授权永不过期（expiresAt = null）。</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">处置与功能（可选，留空用产品默认值）</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="enforcement">处置强度 enforcement</Label>
            <Select
              value={enforcement || '__default'}
              onValueChange={(v) => setEnforcement(v === '__default' ? '' : (v as Enforcement))}
            >
              <SelectTrigger id="enforcement">
                <SelectValue placeholder="用产品默认" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__default">用产品默认</SelectItem>
                {ENFORCEMENTS.map((e) => (
                  <SelectItem key={e} value={e}>
                    {ENFORCEMENT_INFO[e].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {enforcement && (
              <p className="text-xs text-muted-foreground">{ENFORCEMENT_INFO[enforcement].hint}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="features">功能范围 features</Label>
            <Input
              id="features"
              placeholder="逗号或空格分隔，如 basic, export, ai"
              value={features}
              onChange={(e) => setFeatures(e.target.value)}
            />
            {features.trim() && (
              <div className="flex flex-wrap gap-1">
                {parseFeatures(features).map((f) => (
                  <span key={f} className="rounded bg-muted px-2 py-0.5 font-mono text-xs">
                    {f}
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="notice">提醒文案 notice（可选）</Label>
            <Textarea
              id="notice"
              placeholder="留空则到期/停服时由中心自动生成"
              value={notice}
              onChange={(e) => setNotice(e.target.value)}
              rows={2}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="heartbeat">心跳间隔（秒）</Label>
              <Input
                id="heartbeat"
                type="number"
                min={1}
                placeholder="默认 300"
                value={heartbeat}
                onChange={(e) => setHeartbeat(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="grace">失联宽限（秒）</Label>
              <Input
                id="grace"
                type="number"
                min={1}
                placeholder="默认 86400"
                value={grace}
                onChange={(e) => setGrace(e.target.value)}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end gap-2">
        <Button variant="outline" asChild>
          <Link to="/licenses">取消</Link>
        </Button>
        <Button type="submit" disabled={!canSubmit || issue.pending} onClick={onSubmit}>
          {issue.pending && <Loader2 className="size-4 animate-spin" />}
          签发
        </Button>
      </div>
    </div>
  )
}
