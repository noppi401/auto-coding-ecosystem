import { describe, it, expect, vi, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

describe('logger: ログファイルの書き込み先', () => {
  const original = process.env.ECOSYSTEM_LOG_PATH;
  let dir = '';

  afterEach(async () => {
    process.env.ECOSYSTEM_LOG_PATH = original;
    vi.resetModules();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  });

  it('ECOSYSTEM_LOG_PATH を指定すると、そのファイルにログを書く', async () => {
    dir = join(tmpdir(), `ace-logger-test-${randomUUID()}`);
    const logPath = join(dir, 'log', 'current.jsonl');
    process.env.ECOSYSTEM_LOG_PATH = logPath;
    vi.resetModules();
    const { logger } = await import('../../utils/logger.js');

    const marker = `marker-${randomUUID()}`;
    logger.info(marker);

    // 書き込みは非同期（待たない）ため、ファイルに現れるまで待つ
    await vi.waitFor(async () => {
      const content = await fs.readFile(logPath, 'utf-8');
      expect(content).toContain(marker);
    });
  });

  it('テスト実行時は、実行ディレクトリの .ecosystem/log/current.jsonl を書き込み先にしない', () => {
    expect(process.env.ECOSYSTEM_LOG_PATH).toBeTruthy();
    expect(process.env.ECOSYSTEM_LOG_PATH).not.toBe('.ecosystem/log/current.jsonl');
    expect(process.env.ECOSYSTEM_LOG_PATH!.startsWith(process.cwd())).toBe(false);
  });
});
