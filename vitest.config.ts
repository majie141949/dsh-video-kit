import { defineConfig } from 'vitest/config'

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    fileParallelism: false,
    projects: [
      { extends: true, test: { name: 'host', environment: 'node', include: ['src/host/*.test.ts'], testTimeout: 10000 } },
      { extends: true, test: { name: 'client', environment: 'jsdom', include: ['src/client/*.test.tsx'], testTimeout: 10000 } },
    ],
  },
})
