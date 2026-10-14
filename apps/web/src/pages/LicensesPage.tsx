/**
 * 授权列表页：按 productId/appId 过滤，表格展示有效状态/到期/处置强度，
 * 行内快捷操作（延期 90 天、停服、恢复）。写操作走 useAction + toast，成功后刷新列表。
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Ban, Play, Plus, RefreshCw, Search } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Skeleton } from '@/components/ui/skeleton'
import { api, ApiError } from '@/lib/api'
import { useAction, useQuery } from '@/hooks/useApi'
import { ENFORCEMENT_INFO, STATUS_BADGE, formatDateTime, relativeExpiry } from '@/lib/format'

export function LicensesPage() {
  const [productId, setProductId] = useState('')
  const [appId, setAppId] = useState('')
  // 用「已提交」的过滤条件做查询，避免每敲一个字就打接口
  const [applied, setApplied] = useState({ productId: '', appId: '' })

  const licenses = useQuery(() => api.listLicenses(applied), [applied])

  const adjust = useAction(
    (args: { id: string; body: Parameters<typeof api.adjustLicense>[1] }) =>
      api.adjustLicense(args.id, args.body),
    () => void licenses.refresh(),
  )

  function onQuick(id: string, kind: 'extend' | 'suspend' | 'resume') {
    const body =
      kind === 'extend'
        ? { expiresInDays: 90 }
        : kind === 'suspend'
          ? { status: 'suspended' as const }
          : { status: 'active' as const }
    adjust
      .run({ id, body })
      .then((r) => {
        if (r)
          toast.success(
            kind === 'extend' ? '已延期 90 天' : kind === 'suspend' ? '已停服' : '已恢复',
          )
      })
      .catch((e: ApiError) => toast.error(e.message))
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">授权</h1>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => licenses.refresh()}>
            <RefreshCw className="size-4" />
            刷新
          </Button>
          <Button size="sm" asChild>
            <Link to="/licenses/new">
              <Plus className="size-4" />
              签发
            </Link>
          </Button>
        </div>
      </div>

      {/* 过滤器 */}
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 pt-6">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">productId</label>
            <Input
              className="w-48"
              placeholder="全部产品"
              value={productId}
              onChange={(e) => setProductId(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && setApplied({ productId, appId })}
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">appId</label>
            <Input
              className="w-48"
              placeholder="全部 App"
              value={appId}
              onChange={(e) => setAppId(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && setApplied({ productId, appId })}
            />
          </div>
          <Button variant="secondary" size="sm" onClick={() => setApplied({ productId, appId })}>
            <Search className="size-4" />
            过滤
          </Button>
          {(applied.productId || applied.appId) && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setProductId('')
                setAppId('')
                setApplied({ productId: '', appId: '' })
              }}
            >
              清除
            </Button>
          )}
        </CardContent>
      </Card>

      {licenses.error && (
        <Card className="border-destructive">
          <CardContent className="pt-6 text-sm text-destructive">
            {licenses.error.message}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="pt-6">
          {licenses.loading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-12" />
              ))}
            </div>
          ) : !licenses.data?.length ? (
            <p className="py-8 text-center text-sm text-muted-foreground">没有匹配的授权。</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>App / 许可</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>到期</TableHead>
                  <TableHead>处置</TableHead>
                  <TableHead>实例</TableHead>
                  <TableHead>最近心跳</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {licenses.data.map((l) => (
                  <TableRow key={l.licenseId}>
                    <TableCell>
                      <Link to={`/licenses/${l.licenseId}`} className="block hover:underline">
                        <span className="font-medium">{l.appId}</span>
                        <span className="block font-mono text-xs text-muted-foreground">
                          {l.licenseId.slice(0, 8)}…
                        </span>
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Badge
                        className={STATUS_BADGE[l.effectiveStatus].className}
                        variant="outline"
                      >
                        {STATUS_BADGE[l.effectiveStatus].label}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm">
                      {l.expiresAt === null ? (
                        <span className="text-muted-foreground">永不过期</span>
                      ) : (
                        <>
                          <div>{formatDateTime(l.expiresAt)}</div>
                          <div className="text-xs text-muted-foreground">
                            {relativeExpiry(l.expiresAt)}
                          </div>
                        </>
                      )}
                    </TableCell>
                    <TableCell>
                      <span className="font-mono text-xs">{l.enforcement}</span>
                      <span className="block text-xs text-muted-foreground">
                        {ENFORCEMENT_INFO[l.enforcement].label.split(' · ')[1]}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge variant={l.instanceBound ? 'secondary' : 'outline'}>
                        {l.instanceBound ? '已绑定' : '未绑定'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatDateTime(l.lastSeenAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          title="延期 90 天"
                          disabled={adjust.pending}
                          onClick={() => onQuick(l.licenseId, 'extend')}
                        >
                          +90d
                        </Button>
                        {l.manualStatus === 'active' ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            title="停服"
                            disabled={adjust.pending}
                            onClick={() => onQuick(l.licenseId, 'suspend')}
                          >
                            <Ban className="size-4 text-destructive" />
                          </Button>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            title="恢复"
                            disabled={adjust.pending}
                            onClick={() => onQuick(l.licenseId, 'resume')}
                          >
                            <Play className="size-4 text-success" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
