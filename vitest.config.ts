import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Use child-process forks so native Node addons (better-sqlite3) load correctly.
    pool: 'forks',
    include: ['tests/**/*.test.ts'],
  },
});
