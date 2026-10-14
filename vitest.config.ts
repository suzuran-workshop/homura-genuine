import { defineConfig } from 'vitest/config'

/**
 * monorepo 聚合测试入口。
 *
 * vitest 3 用 projects 取代已弃用的 workspace 文件。apps/web 目前无测试文件，
 * passWithNoTests 保证单独 filter 到它时不会「No test files found」非零退出。
 */
export default defineConfig({
  test: {
    projects: ['apps/*', 'packages/*'],
    passWithNoTests: true,
  },
})
