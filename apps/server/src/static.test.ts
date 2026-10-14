import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { buildApp } from './app.ts'

/**
 * 静态托管中间件（同源托管 web 管理台）的行为契约。
 *
 * 重点守三条会静默出 bug 的规则：API 前缀豁免（否则 App 打错端点会拿到 HTML）、
 * 仅 GET/HEAD、webRoot 缺省时零回归（未匹配路径仍 JSON 404）。
 */

const tmp = mkdtempSync(join(tmpdir(), 'genuine-web-'))
mkdirSync(join(tmp, 'assets'), { recursive: true })
writeFileSync(join(tmp, 'index.html'), '<!doctype html><title>admin</title>')
writeFileSync(join(tmp, 'assets', 'app-abc123.js'), 'console.log(1)')
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

describe('webRoot 缺省 → 不挂静态托管（现有 JSON 404 零回归）', () => {
  it('未匹配路径仍返回 JSON not_found，不是 HTML', async () => {
    const { app } = buildApp() // 不传 webRoot
    const res = await app.request('/licenses')
    expect(res.status).toBe(404)
    await expect(res.json()).resolves.toMatchObject({ error: 'not_found' })
  })
})

describe('webRoot 存在 → 同源托管', () => {
  const { app } = buildApp({ webRoot: tmp, adminToken: 'tok' })

  it('前端路由（非 API 前缀）SPA fallback 到 index.html', async () => {
    const res = await app.request('/licenses/abc')
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/html')
    expect(res.headers.get('Cache-Control')).toBe('no-cache')
    await expect(res.text()).resolves.toContain('<title>admin</title>')
  })

  it('根路径 / 返回 index.html', async () => {
    const res = await app.request('/')
    expect(res.status).toBe(200)
    await expect(res.text()).resolves.toContain('admin')
  })

  it('assets/* 命中真实文件且长缓存 immutable', async () => {
    const res = await app.request('/assets/app-abc123.js')
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('javascript')
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable')
  })

  it('API 前缀豁免：/v1 与 /healthz 下拼错端点 → JSON 404，不是 SPA HTML', async () => {
    for (const path of ['/v1/keey', '/healthz/nope', '/admin/keys/nope']) {
      const res = await app.request(path, {
        // /admin/* 需带 token 才越过鉴权、落到 notFound；否则先撞 401
        headers: path.startsWith('/admin') ? { authorization: 'Bearer tok' } : {},
      })
      expect(res.status, path).toBe(404)
      await expect(res.json(), path).resolves.toMatchObject({ error: 'not_found' })
    }
  })

  it('非 API 的未知路径 → SPA fallback 到 index.html（交给前端路由，非 JSON 404）', async () => {
    const res = await app.request('/nope')
    expect(res.status).toBe(200)
    await expect(res.text()).resolves.toContain('<title>admin</title>')
  })

  it('未鉴权的 /admin/* 未匹配路径 → 先撞鉴权（401），不会被 SPA 吞成 200', async () => {
    const res = await app.request('/admin/nope')
    expect(res.status).toBe(401)
  })

  it('已鉴权的 /admin/* 未匹配路径 → JSON 404（豁免生效），不是 HTML', async () => {
    const res = await app.request('/admin/nope', { headers: { authorization: 'Bearer tok' } })
    expect(res.status).toBe(404)
    await expect(res.json()).resolves.toMatchObject({ error: 'not_found' })
  })

  it('POST 到未匹配的非 API 路径 → 不走 SPA fallback（仅 GET/HEAD）', async () => {
    const res = await app.request('/licenses', { method: 'POST' })
    expect(res.status).toBe(404)
    await expect(res.json()).resolves.toMatchObject({ error: 'not_found' })
  })

  it('路径穿越 ../ 不能逃出 webRoot', async () => {
    const res = await app.request('/../../etc/passwd')
    // 穿越被拦 → 落到 SPA fallback（index.html）或 JSON 404，总之绝不能返回系统文件
    expect([200, 404]).toContain(res.status)
    const text = await res.text()
    expect(text).not.toContain('root:')
  })
})
