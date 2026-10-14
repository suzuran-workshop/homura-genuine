/**
 * 手写静态托管中间件：同源托管 web 管理台的构建产物（apps/web/dist）。
 *
 * 为什么不用 @hono/node-server/serve-static：该子路径模块在 Windows + stdout 是管道
 * （根脚本 concurrently 下）时会让 tsx watch 挂死（tsx#623），而本服务 dev 正是这个组合。
 * 参照 ../momoi 的手写方案。
 *
 * 三条不可省的规则（漏一条就出隐蔽 bug）：
 * 1. **API 前缀豁免**：/healthz、/v1/*、/admin/* 一律 next()，交给 app.notFound 返回 JSON 404。
 *    否则 App 侧打错的端点（如 /v1/keey）会被 SPA fallback 吞成 200 + index.html，
 *    App 拿 HTML 当授权响应解析 → 静默误判。
 * 2. **仅 GET/HEAD**：POST 到未匹配路径若被 SPA 兜底会返回 200 HTML，掩盖真实错误。
 * 3. **路径穿越防护**：resolve 后必须仍在 webRoot 内。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import type { Context, MiddlewareHandler, Next } from 'hono'
import { getMimeType } from 'hono/utils/mime'

/** API 前缀：这些路径永不走静态托管/SPA fallback */
const API_PREFIX = /^\/(healthz|v1|admin)(\/|$)/

/** 按 Accept-Encoding 选择预压缩产物（vite 默认不生成 .gz/.br，此分支自然落空，无害且便于日后加压缩插件） */
function toBytes(buf: Buffer): Uint8Array<ArrayBuffer> {
  // @types/node 24 下 `new Uint8Array(buffer)` 的类型是 Uint8Array<ArrayBufferLike>，
  // Hono 的 c.body 要 Uint8Array<ArrayBuffer>；按长度新建 + set 得到明确的 ArrayBuffer 后端。
  const bytes = new Uint8Array(buf.byteLength)
  bytes.set(buf)
  return bytes
}

function readBody(
  file: string,
  acceptEncoding: string,
): { body: Uint8Array<ArrayBuffer>; encoding?: string } {
  if (acceptEncoding.includes('br') && existsSync(`${file}.br`)) {
    return { body: toBytes(readFileSync(`${file}.br`)), encoding: 'br' }
  }
  if (acceptEncoding.includes('gzip') && existsSync(`${file}.gz`)) {
    return { body: toBytes(readFileSync(`${file}.gz`)), encoding: 'gzip' }
  }
  return { body: toBytes(readFileSync(file)) }
}

function send(c: Context, file: string, contentType: string, cacheControl: string) {
  const acceptEncoding = c.req.header('Accept-Encoding') ?? ''
  const { body, encoding } = readBody(file, acceptEncoding)
  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'Cache-Control': cacheControl,
    Vary: 'Accept-Encoding',
  }
  if (encoding) headers['Content-Encoding'] = encoding
  return c.body(body, 200, headers)
}

/**
 * 创建静态托管中间件。webRoot 由 server.ts 传入（`resolve(repoRoot(), 'apps/web/dist')`）。
 * 目录不存在时中间件仍可挂载——所有请求都会 next() 透传到 JSON notFound（server.ts 会另行告警）。
 */
export function createStaticMiddleware(webRoot: string): MiddlewareHandler {
  const root = resolve(webRoot)
  const indexHtml = resolve(root, 'index.html')

  return async (c: Context, next: Next) => {
    // 规则 2：仅 GET/HEAD
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return next()
    // 规则 1：API 前缀豁免，交给 JSON notFound
    if (API_PREFIX.test(c.req.path)) return next()

    // 解析请求路径为磁盘文件，带穿越防护（规则 3）
    let file = ''
    try {
      const rel = decodeURIComponent(c.req.path).replace(/^\/+/, '') || 'index.html'
      const candidate = resolve(root, rel)
      if (candidate === root || candidate.startsWith(root + sep)) file = candidate
    } catch {
      file = ''
    }

    if (file && existsSync(file) && statSync(file).isFile()) {
      // Vite 产物带内容哈希：assets/* 可长缓存；其余（index.html 等）不得缓存，
      // 否则内置浏览器会长期吃旧 HTML，发版后无法生效。
      const isHashed = c.req.path.startsWith('/assets/')
      return send(
        c,
        file,
        getMimeType(file) ?? 'application/octet-stream',
        isHashed ? 'public, max-age=31536000, immutable' : 'no-cache',
      )
    }

    // SPA fallback：未命中文件的前端路由（如 /licenses/123）回 index.html，交给 react-router
    if (existsSync(indexHtml)) {
      return send(c, indexHtml, 'text/html; charset=utf-8', 'no-cache')
    }

    // webRoot 不存在或无 index.html：透传，让 app.notFound 返回 JSON
    return next()
  }
}
