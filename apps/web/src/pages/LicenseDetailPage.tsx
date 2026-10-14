/**
 * 授权详情/编辑页：到期（含 expiresInDays 快捷与永不过期）、status、enforcement、features、
 * notice、心跳、宽限。PATCH /admin/licenses/:id。
 *
 * PATCH 语义（务必对齐后端 adjustLicense）：
 *   - 字段不传（undefined）= 不改
 *   - expiresAt: null = 永不过期；ISO/数字 = 改到期
 *   - notice: null = 清空（回落自动生成）；字符串 = 设为该文案
 * 本页把「当前值」预填进表单，提交时只发送用户实际改动的字段，避免误覆盖。
 */
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, Loader2, Save } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { api, ApiError } from '@/lib/api'
import { useAction, useQuery } from '@/hooks/useApi'
import {
  ENFORCEMENTS,
  ENFORCEMENT_INFO,
  MANUAL_STATUSES,
  MANUAL_STATUS_LABEL,
  STATUS_BADGE,
  formatDateInput,
  formatDateTime,
  formatInterval,
  relativeExpiry,
} from '@/lib/format'
import type { Enforcement } from '@homura-genuine/contract/contract'
import type { AdjustLicenseBody, ManualStatus } from '@homura-genuine/contract/admin'

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

export function LicenseDetailPage() {
  const { id = '' } = useParams()
  const license = useQuery(() => api.getLicense(id), [id])

  // 表单态（编辑副本）
  const [expiryMode, setExpiryMode] = useState<'keep' | 'date' | 'never'>('keep')
  const [date, setDate] = useState('')
  const [quickDays, setQuickDays] = useState('')
  const [status, setStatus] = useState<ManualStatus | ''>('')
  const [enforcement, setEnforcement] = useState<Enforcement | ''>('')
  const [features, setFeatures] = useState('')
  const [notice, setNotice] = useState('')
  const [noticeMode, setNoticeMode] = useState<'keep' | 'set' | 'clear'>('keep')
  const [heartbeat, setHeartbeat] = useState('')
  const [grace, setGrace] = useState('')

  // 数据到达后预填表单
  useEffect(() => {
    const l = license.data
    if (!l) return
    setExpiryMode('keep')
    setDate(formatDateInput(l.expiresAt))
    setQuickDays('')
    setStatus(l.manualStatus)
    setEnforcement(l.enforcement)
    setFeatures(l.features.join(', '))
    setNotice(l.notice ?? '')
    setNoticeMode('keep')
    setHeartbeat(String(l.heartbeatIntervalSec))
    setGrace(String(l.graceSec))
  }, [license.data])

  const save = useAction(
    (body: AdjustLicenseBody) => api.adjustLicense(id, body),
    (updated) => {
      toast.success('已保存，下一次心跳即生效')
      // 用返回的最新值刷新本地表单
      setExpiryMode('keep')
      setDate(formatDateInput(updated.expiresAt))
      setStatus(updated.manualStatus)
      setEnforcement(updated.enforcement)
      setFeatures(updated.features.join(', '))
      setNotice(updated.notice ?? '')
      setNoticeMode('keep')
      setHeartbeat(String(updated.heartbeatIntervalSec))
      setGrace(String(updated.graceSec))
      void license.refresh()
    },
  )

  function buildPatch(): AdjustLicenseBody {
    const patch: AdjustLicenseBody = {}
    if (expiryMode === 'never') patch.expiresAt = null
    else if (expiryMode === 'date' && date)
      patch.expiresAt = new Date(`${date}T00:00:00`).toISOString()
    if (quickDays.trim()) patch.expiresInDays = Number(quickDays)
    if (status) patch.status = status
    if (enforcement) patch.enforcement = enforcement
    patch.features = parseFeatures(features)
    if (noticeMode === 'clear') patch.notice = null
    else if (noticeMode === 'set') patch.notice = notice.trim() || null
    if (heartbeat.trim()) patch.heartbeatIntervalSec = Number(heartbeat)
    if (grace.trim()) patch.graceSec = Number(grace)
    return patch
  }

  function onSave(e: React.FormEvent) {
    e.preventDefault()
    save.run(buildPatch()).catch((err: ApiError) => toast.error(err.message))
  }

  if (license.loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64" />
      </div>
    )
  }
  if (license.error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          {license.error.message}{' '}
          <Link to="/licenses" className="underline">
            返回列表
          </Link>
        </AlertDescription>
      </Alert>
    )
  }
  const l = license.data!

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" asChild>
          <Link to="/licenses">
            <ArrowLeft className="size-4" />
            返回
          </Link>
        </Button>
        <h1 className="text-2xl font-bold tracking-tight">{l.appId}</h1>
        <Badge className={STATUS_BADGE[l.effectiveStatus].className} variant="outline">
          {STATUS_BADGE[l.effectiveStatus].label}
        </Badge>
      </div>

      <Card>
        <CardContent className="space-y-1 pt-6 font-mono text-xs text-muted-foreground">
          <div>licenseId: {l.licenseId}</div>
          <div>productId: {l.productId}</div>
          <div>
            实例:{' '}
            {l.instanceBound ? '已绑定（注册时固定 instanceKey）' : '未绑定（预签发，等首次注册）'}
          </div>
          <div>
            创建于 {formatDateTime(l.createdAt)} · 最近心跳 {formatDateTime(l.lastSeenAt)}
          </div>
          <div className="text-destructive">⚠ licenseKey 原文与私钥不在此显示（后端从不回吐）</div>
        </CardContent>
      </Card>

      <form onSubmit={onSave} className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">有效期</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="text-sm">
              当前：
              {l.expiresAt === null
                ? '永不过期'
                : `${formatDateTime(l.expiresAt)}（${relativeExpiry(l.expiresAt)}）`}
            </div>
            <div className="flex flex-wrap gap-2">
              {(
                [
                  ['keep', '不改'],
                  ['date', '设为具体日期'],
                  ['never', '永不过期'],
                ] as ['keep' | 'date' | 'never', string][]
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
            {expiryMode === 'date' && (
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            )}
            <Separator />
            <div className="space-y-2">
              <Label htmlFor="quickDays">快捷延期（天）</Label>
              <Input
                id="quickDays"
                type="number"
                min={1}
                placeholder="从现在起 N 天，如 90；留空则不改"
                value={quickDays}
                onChange={(e) => setQuickDays(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                填了会覆盖上面的「具体日期/永不过期」（后端 expiresInDays 优先）。
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">状态与处置</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="status">手动状态</Label>
                <Select value={status} onValueChange={(v) => setStatus(v as ManualStatus)}>
                  <SelectTrigger id="status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MANUAL_STATUSES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {MANUAL_STATUS_LABEL[s]}（{s}）
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="enforcement">处置强度</Label>
                <Select
                  value={enforcement}
                  onValueChange={(v) => setEnforcement(v as Enforcement)}
                  disabled={l.effectiveStatus === 'active'}
                >
                  <SelectTrigger id="enforcement">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ENFORCEMENTS.map((e) => (
                      <SelectItem key={e} value={e}>
                        {ENFORCEMENT_INFO[e].label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            {l.effectiveStatus === 'active' && (
              <p className="text-xs text-muted-foreground">
                有效状态为 active 时 enforcement 恒为 none（不给消费侧留误拦余地），故此处禁改。
              </p>
            )}
            {enforcement && (
              <p className="text-xs text-muted-foreground">{ENFORCEMENT_INFO[enforcement].hint}</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">功能范围与提醒</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="features">features（逗号/空格分隔）</Label>
              <Input id="features" value={features} onChange={(e) => setFeatures(e.target.value)} />
              {parseFeatures(features).length > 0 && (
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
              <Label htmlFor="notice">提醒文案 notice</Label>
              <div className="flex gap-2">
                {(
                  [
                    ['keep', '不改'],
                    ['set', '设为下方文案'],
                    ['clear', '清空（回落自动生成）'],
                  ] as ['keep' | 'set' | 'clear', string][]
                ).map(([mode, label]) => (
                  <Button
                    key={mode}
                    type="button"
                    size="sm"
                    variant={noticeMode === mode ? 'default' : 'outline'}
                    onClick={() => setNoticeMode(mode)}
                  >
                    {label}
                  </Button>
                ))}
              </div>
              <Textarea
                id="notice"
                value={notice}
                onChange={(e) => setNotice(e.target.value)}
                disabled={noticeMode !== 'set'}
                rows={2}
                placeholder="到期/停服时展示给所有用户的强提醒"
              />
              <p className="text-xs text-muted-foreground">
                当前值：{l.notice === null ? '（无，非 active 时中心自动生成）' : l.notice}
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">心跳参数</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="heartbeat">心跳间隔（秒）</Label>
              <Input
                id="heartbeat"
                type="number"
                min={1}
                value={heartbeat}
                onChange={(e) => setHeartbeat(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                当前 {formatInterval(l.heartbeatIntervalSec)}
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="grace">失联宽限（秒）</Label>
              <Input
                id="grace"
                type="number"
                min={1}
                value={grace}
                onChange={(e) => setGrace(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">当前 {formatInterval(l.graceSec)}</p>
            </div>
          </CardContent>
        </Card>

        <div className="flex justify-end gap-2">
          <Button variant="outline" asChild>
            <Link to="/licenses">取消</Link>
          </Button>
          <Button type="submit" disabled={save.pending}>
            {save.pending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Save className="size-4" />
            )}
            保存
          </Button>
        </div>
      </form>
    </div>
  )
}
