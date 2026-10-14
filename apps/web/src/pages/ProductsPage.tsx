/**
 * 产品管理页：列表 + upsert（PUT /admin/products/:id）。
 * 字段：name、defaultFeatures、defaultEnforcement、defaultTtlDays、allowSelfRegister。
 *
 * ⚠ allowSelfRegister 必须传**真 boolean**（后端 `body['allowSelfRegister'] === true` 严格判定，
 *   传 "true"/1 会被当成 false）。
 * ⚠ 开启自助注册 = 放弃实例管控（ADR-007）：每个 (product, app, instanceKey) 首次注册各签一张，
 *   UI 上必须显眼警示。
 */
import { useState } from 'react'
import { Pencil, Plus, RefreshCw, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { api, ApiError } from '@/lib/api'
import { useAction, useQuery } from '@/hooks/useApi'
import { ENFORCEMENTS, ENFORCEMENT_INFO } from '@/lib/format'
import type { Enforcement } from '@homura-genuine/contract/contract'
import type { AdminProduct, UpsertProductBody } from '@homura-genuine/contract/admin'

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

/** 对话框表单的初值 */
function emptyForm() {
  return {
    id: '',
    name: '',
    featuresText: '',
    enforcement: 'all' as Enforcement,
    ttlDays: '30', // 空串 = 永不过期（null）
    allowSelfRegister: false,
  }
}

export function ProductsPage() {
  const products = useQuery(() => api.listProducts(), [])
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<AdminProduct | null>(null)
  const [form, setForm] = useState(emptyForm())

  const saveProduct = useAction(
    (args: { id: string; body: UpsertProductBody }) => api.upsertProduct(args.id, args.body),
    () => {
      toast.success(editing ? '产品已更新' : '产品已创建')
      setOpen(false)
      void products.refresh()
    },
  )

  function openCreate() {
    setEditing(null)
    setForm(emptyForm())
    setOpen(true)
  }

  function openEdit(p: AdminProduct) {
    setEditing(p)
    setForm({
      id: p.id,
      name: p.name,
      featuresText: p.defaultFeatures.join(', '),
      enforcement: p.defaultEnforcement,
      ttlDays: p.defaultTtlDays === null ? '' : String(p.defaultTtlDays),
      allowSelfRegister: p.allowSelfRegister,
    })
    setOpen(true)
  }

  function onSubmit() {
    if (!form.id.trim()) {
      toast.error('产品 id 必填')
      return
    }
    const body: UpsertProductBody = {
      name: form.name.trim() || form.id.trim(),
      defaultFeatures: parseFeatures(form.featuresText),
      defaultEnforcement: form.enforcement,
      // 空串 = 永不过期（null）；否则为正整数天数
      defaultTtlDays: form.ttlDays.trim() === '' ? null : Number(form.ttlDays),
      allowSelfRegister: form.allowSelfRegister, // 真 boolean
    }
    saveProduct.run({ id: form.id.trim(), body }).catch((e: ApiError) => toast.error(e.message))
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">产品</h1>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => products.refresh()}>
            <RefreshCw className="size-4" />
            刷新
          </Button>
          <Button size="sm" onClick={openCreate}>
            <Plus className="size-4" />
            新建产品
          </Button>
        </div>
      </div>

      {products.error && (
        <Alert variant="destructive">
          <AlertDescription>{products.error.message}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardContent className="pt-6">
          {products.loading ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-14" />
              ))}
            </div>
          ) : !products.data?.length ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              还没有产品。点「新建产品」创建一个——授权必须挂在某个产品下。
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>id / 名称</TableHead>
                  <TableHead>默认功能</TableHead>
                  <TableHead>默认处置</TableHead>
                  <TableHead>默认 TTL</TableHead>
                  <TableHead>自助注册</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {products.data.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>
                      <span className="font-mono text-sm">{p.id}</span>
                      <span className="block text-xs text-muted-foreground">{p.name}</span>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {p.defaultFeatures.length ? (
                          p.defaultFeatures.map((f) => (
                            <Badge key={f} variant="secondary" className="font-mono text-xs">
                              {f}
                            </Badge>
                          ))
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <span className="font-mono text-xs">{p.defaultEnforcement}</span>
                    </TableCell>
                    <TableCell className="text-sm">
                      {p.defaultTtlDays === null ? '永不过期' : `${p.defaultTtlDays} 天`}
                    </TableCell>
                    <TableCell>
                      {p.allowSelfRegister ? (
                        <Badge
                          className="bg-amber-500/15 text-amber-700 dark:text-amber-400"
                          variant="outline"
                        >
                          <TriangleAlert className="mr-1 size-3" />
                          已开启
                        </Badge>
                      ) : (
                        <Badge variant="outline">关闭</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" onClick={() => openEdit(p)}>
                        <Pencil className="size-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? `编辑产品 ${editing.id}` : '新建产品'}</DialogTitle>
            <DialogDescription>
              {editing
                ? '修改后对该产品的新签发授权生效（存量授权的 enforcement/features 不随产品默认值改变）。'
                : 'id 创建后不可改（是产品主键）。'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="pid">产品 id *</Label>
              <Input
                id="pid"
                placeholder="如 pro / template-app"
                value={form.id}
                disabled={!!editing}
                onChange={(e) => setForm({ ...form, id: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="pname">名称</Label>
              <Input
                id="pname"
                placeholder="留空则用 id"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="pfeatures">默认功能范围（逗号/空格分隔）</Label>
              <Input
                id="pfeatures"
                placeholder="如 basic, export"
                value={form.featuresText}
                onChange={(e) => setForm({ ...form, featuresText: e.target.value })}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="penf">默认处置强度</Label>
                <Select
                  value={form.enforcement}
                  onValueChange={(v) => setForm({ ...form, enforcement: v as Enforcement })}
                >
                  <SelectTrigger id="penf">
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
              <div className="space-y-2">
                <Label htmlFor="pttl">默认 TTL（天）</Label>
                <Input
                  id="pttl"
                  type="number"
                  min={1}
                  placeholder="留空=永不过期"
                  value={form.ttlDays}
                  onChange={(e) => setForm({ ...form, ttlDays: e.target.value })}
                />
              </div>
            </div>

            <div className="rounded-md border p-3">
              <div className="flex items-center justify-between gap-4">
                <div className="space-y-0.5">
                  <Label htmlFor="pself" className="text-sm">
                    允许自助注册
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    开启后，任何 App 首次注册即可自助领一张授权。
                  </p>
                </div>
                <Switch
                  id="pself"
                  checked={form.allowSelfRegister}
                  onCheckedChange={(v) => setForm({ ...form, allowSelfRegister: v })}
                />
              </div>
              {form.allowSelfRegister && (
                <Alert className="mt-3 border-amber-500/40 bg-amber-500/10">
                  <TriangleAlert className="size-4 text-amber-600 dark:text-amber-400" />
                  <AlertDescription className="text-amber-800 dark:text-amber-200">
                    自助注册 = <strong>放弃实例管控</strong>（ADR-007）：每个 instanceKey 各签一张，
                    无法「一实例一授权」。要管控就别开，改由中心预签发 + licenseKey 分发。
                  </AlertDescription>
                </Alert>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button onClick={onSubmit} disabled={saveProduct.pending}>
              {editing ? '保存' : '创建'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
