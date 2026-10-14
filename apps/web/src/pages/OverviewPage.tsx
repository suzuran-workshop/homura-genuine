/**
 * 总览页：服务健康、产品/授权计数、有效状态分布、当前签名 keyId。
 * 只读聚合，用 useQuery 拉三组数据（products / licenses / keys）+ health。
 */
import { Link } from 'react-router-dom'
import { Activity, KeyRound, Package, ShieldCheck } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { useQuery } from '@/hooks/useApi'
import { STATUS_BADGE, formatDateTime } from '@/lib/format'
import type { LicenseStatus } from '@homura-genuine/contract/contract'

function StatCard({
  icon: Icon,
  label,
  value,
  to,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: React.ReactNode
  to?: string
}) {
  const body = (
    <Card className="transition-colors hover:bg-accent/30">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
        <Icon className="size-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
      </CardContent>
    </Card>
  )
  return to ? <Link to={to}>{body}</Link> : body
}

export function OverviewPage() {
  const health = useQuery(() => api.health(), [])
  const products = useQuery(() => api.listProducts(), [])
  const licenses = useQuery(() => api.listLicenses(), [])
  const keys = useQuery(() => api.listKeys(), [])

  const loading = health.loading || products.loading || licenses.loading || keys.loading
  const activeKey = keys.data?.find((k) => !k.retired) ?? null

  // 有效状态分布
  const dist = new Map<LicenseStatus, number>()
  for (const l of licenses.data ?? []) {
    dist.set(l.effectiveStatus, (dist.get(l.effectiveStatus) ?? 0) + 1)
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">总览</h1>
        <Badge variant={health.data?.status === 'ok' ? 'default' : 'destructive'}>
          <Activity className="mr-1 size-3" />
          {health.error ? '服务不可达' : health.data?.status === 'ok' ? '服务正常' : '检测中'}
        </Badge>
      </div>

      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              icon={Package}
              label="产品"
              value={products.data?.length ?? 0}
              to="/products"
            />
            <StatCard
              icon={ShieldCheck}
              label="授权"
              value={licenses.data?.length ?? 0}
              to="/licenses"
            />
            <StatCard icon={KeyRound} label="签名密钥" value={keys.data?.length ?? 0} to="/keys" />
            <StatCard
              icon={Activity}
              label="当前 keyId"
              value={<span className="font-mono text-base">{activeKey?.keyId ?? '—'}</span>}
              to="/keys"
            />
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">授权状态分布</CardTitle>
            </CardHeader>
            <CardContent>
              {licenses.data?.length ? (
                <div className="flex flex-wrap gap-3">
                  {[...dist.entries()].map(([status, count]) => (
                    <div key={status} className="flex items-center gap-2">
                      <Badge className={STATUS_BADGE[status].className} variant="outline">
                        {STATUS_BADGE[status].label}
                      </Badge>
                      <span className="text-sm tabular-nums">{count}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  还没有任何授权。去{' '}
                  <Link to="/licenses/new" className="underline">
                    签发一张
                  </Link>
                  ， 或先{' '}
                  <Link to="/products" className="underline">
                    建产品
                  </Link>
                  。
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">最近活跃</CardTitle>
            </CardHeader>
            <CardContent>
              {(() => {
                const recent = [...(licenses.data ?? [])]
                  .filter((l) => l.lastSeenAt !== null)
                  .sort((a, b) => Date.parse(b.lastSeenAt!) - Date.parse(a.lastSeenAt!))
                  .slice(0, 5)
                if (!recent.length) {
                  return <p className="text-sm text-muted-foreground">暂无心跳记录。</p>
                }
                return (
                  <ul className="space-y-2 text-sm">
                    {recent.map((l) => (
                      <li key={l.licenseId} className="flex items-center justify-between gap-4">
                        <Link
                          to={`/licenses/${l.licenseId}`}
                          className="truncate font-mono hover:underline"
                        >
                          {l.appId} · {l.licenseId.slice(0, 8)}
                        </Link>
                        <span className="shrink-0 text-muted-foreground">
                          {formatDateTime(l.lastSeenAt)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )
              })()}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}
