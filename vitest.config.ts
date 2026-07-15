import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  test: {
    globals: true,
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts', 'scripts/**/*.test.ts', 'dashboard/**/*.test.ts'],
    environment: 'node',
  },
});
