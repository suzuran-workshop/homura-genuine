/**
 * 展示层格式化：状态徽章配色、日期、处置强度说明。
 * 纯函数、无 DOM、无副作用——可直接在 node 环境测。
 */
import type { Enforcement, LicenseStatus } from '@homura-genuine/contract/contract'
import type { ManualStatus } from '@homura-genuine/contract/admin'

/** 有效状态 → 徽章文案与配色（Tailwind class） */
export const STATUS_BADGE: Record<LicenseStatus, { label: string; className: string }> = {
  active: {
    label: '生效中',
    className: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  },
  expired: { label: '已过期', className: 'bg-amber-500/15 text-amber-700 dark:text-amber-400' },
  suspended: { label: '已停服', className: 'bg-red-500/15 text-red-700 dark:text-red-400' },
  grace: { label: '宽限期', className: 'bg-sky-500/15 text-sky-700 dark:text-sky-400' },
  unknown: { label: '未知', className: 'bg-zinc-500/15 text-zinc-600 dark:text-zinc-400' },
}

/** 手动状态 → 文案（库里存的三态；有效状态另见 STATUS_BADGE） */
export const MANUAL_STATUS_LABEL: Record<ManualStatus, string> = {
  active: '正常',
  suspended: '暂停',
  revoked: '吊销',
}

/** 处置强度四档 → 中文说明（对应 README 的 enforcement 表） */
export const ENFORCEMENT_INFO: Record<Enforcement, { label: string; hint: string }> = {
  none: { label: 'none · 只记录', hint: '功能全开、不提醒（观察期用；active 时中心恒下发此值）' },
  notice: { label: 'notice · 强提醒', hint: '功能全开，但每个响应带强提醒，前端每次使用都要展示' },
  core: {
    label: 'core · 禁核心',
    hint: '禁核心功能（App 用 corePaths 声明）→ 503，其余放行 + 强提醒',
  },
  all: { label: 'all · 全站停服', hint: '全站 503（豁免路径除外）+ 强提醒' },
}

export const ENFORCEMENTS: Enforcement[] = ['none', 'notice', 'core', 'all']
export const MANUAL_STATUSES: ManualStatus[] = ['active', 'suspended', 'revoked']

/**
 * ISO 时间戳 → 本地可读字符串。null（永不过期 / 从未心跳）显示占位符。
 * 不依赖真实时钟做判定，只做展示格式化。
 */
export function formatDateTime(iso: string | null): string {
  if (iso === null) return '—'
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return iso
  const d = new Date(t)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** ISO → 仅日期（YYYY-MM-DD），用于到期日输入框的初值 */
export function formatDateInput(iso: string | null): string {
  if (iso === null) return ''
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  return new Date(t).toISOString().slice(0, 10)
}

/** 距到期的相对描述（还剩 N 天 / 已过期 N 天 / 永不过期）；now 可注入以便测试 */
export function relativeExpiry(expiresAt: string | null, now: number = Date.now()): string {
  if (expiresAt === null) return '永不过期'
  const t = Date.parse(expiresAt)
  if (Number.isNaN(t)) return '—'
  const days = Math.round((t - now) / 86_400_000)
  if (days > 0) return `还剩 ${days} 天`
  if (days === 0) return '今天到期'
  return `已过期 ${Math.abs(days)} 天`
}

/** 心跳间隔秒数 → 人类可读 */
export function formatInterval(sec: number): string {
  if (sec < 60) return `${sec} 秒`
  if (sec < 3600) return `${Math.round(sec / 60)} 分钟`
  return `${(sec / 3600).toFixed(1)} 小时`
}
