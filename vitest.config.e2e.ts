import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    setupFiles: ['./test/postgres.setup.ts'],
    fileParallelism: false,
    // These scenarios perform many real database/HTTP round trips, not unit-only work.
    testTimeout: 15000,
    hookTimeout: 30000,
    root: './',
    include: ['**/*.e2e-spec.ts'],
  },
});
