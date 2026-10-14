import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * web 管理台构建配置。
 *
 * - 同源部署：产物落 apps/web/dist，由 server 的 static.ts 托管（单进程单端口，无跨域）。
 * - 开发期：vite dev server 起 :5173，把 /admin、/v1、/healthz 代理到后端 :8787，
 *   浏览器视角仍是同源，无需后端开 CORS。
 * - @/ 别名指向 src（tsconfig paths 与此处 resolve.alias 两处都要配，缺一处会 TS 报错或构建炸）。
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/admin': { target: 'http://localhost:8787', changeOrigin: true },
      '/v1': { target: 'http://localhost:8787', changeOrigin: true },
      '/healthz': { target: 'http://localhost:8787', changeOrigin: true },
    },
  },
})
