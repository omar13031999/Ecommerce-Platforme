import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)), 'server-only': fileURLToPath(new URL('./tests/server-only-stub.ts', import.meta.url)) } },
  test: { include: process.env.LIVE ? ['tests/live/**/*.live.ts'] : ['tests/**/*.test.ts'], environment: 'node' },
});
