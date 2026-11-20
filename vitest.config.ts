import { defineConfig } from 'vitest/config';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // テスト中のログを、実行ディレクトリの .ecosystem/log/current.jsonl に書かない
    env: {
      ECOSYSTEM_LOG_PATH: join(tmpdir(), 'ace-test-logs', 'current.jsonl'),
    },
    include: ['src/__tests__/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/ui/**', 'src/index.ts', 'src/__tests__/**'],
    },
  },
});
