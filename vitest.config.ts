import { defineConfig } from 'vitest/config'

// Unit tests run in plain Node (the write-path logic is DOM-free). Kept
// separate from vite.config.ts so the build-only CSP plugin never loads here.
export default defineConfig({
  test: {
    environment: 'node',
    // `api/` is in here too: the serverless guards (SSRF address checks) are
    // exactly the kind of logic that needs covering.
    include: ['src/**/*.test.ts', 'api/**/*.test.ts'],
  },
})
