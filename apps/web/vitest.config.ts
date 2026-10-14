import { defineConfig } from 'vitest/config'

/**
 * web 侧测试。lib/*（api、auth、format）是纯逻辑，走 node 环境、不装 jsdom。
 * 组件测试（若日后加）用文件级 docblock `// @vitest-environment happy-dom` 单独启用。
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
