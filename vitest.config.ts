import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  // Resolves the path aliases declared in tsconfig.json, including the ones
  // added by `nest g library`.
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    setupFiles: ['./test/postgres.setup.ts'],
    fileParallelism: false,
    hookTimeout: 30000,
    root: './',
    include: ['**/*.spec.ts'],
  },
});
