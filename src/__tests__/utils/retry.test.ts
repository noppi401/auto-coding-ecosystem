import { describe, it, expect, vi, beforeEach } from 'vitest';
import { withRetry } from '../../utils/retry.js';

vi.mock('../../utils/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

describe('withRetry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('成功した場合は即座に値を返す', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, 'test');
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('リトライ可能エラーで失敗→成功するまでリトライする', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('rate_limit exceeded'))
      .mockResolvedValue('ok');

    const result = await withRetry(fn, 'test', {
      maxAttempts: 3,
      initialDelay: 0,
      maxDelay: 0,
    });

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('maxAttempts を超えたら最後のエラーをスローする', async () => {
    const err = new Error('rate_limit exceeded');
    const fn = vi.fn().mockRejectedValue(err);

    await expect(
      withRetry(fn, 'test', { maxAttempts: 3, initialDelay: 0, maxDelay: 0 })
    ).rejects.toThrow('rate_limit exceeded');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('リトライ不可エラーは即座にスローする', async () => {
    const err = new Error('some unrelated error');
    const fn = vi.fn().mockRejectedValue(err);

    await expect(
      withRetry(fn, 'test', { maxAttempts: 3, initialDelay: 0, maxDelay: 0 })
    ).rejects.toThrow('some unrelated error');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('timeout エラーはリトライ対象になる', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('connection timeout'))
      .mockResolvedValue('done');

    const result = await withRetry(fn, 'test', {
      maxAttempts: 3,
      initialDelay: 0,
      maxDelay: 0,
    });
    expect(result).toBe('done');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('ECONNREFUSED エラーはリトライ対象になる', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValue('done');

    const result = await withRetry(fn, 'test', {
      maxAttempts: 3,
      initialDelay: 0,
      maxDelay: 0,
    });
    expect(result).toBe('done');
  });

  it('Error インスタンスでない rejection はリトライしない', async () => {
    const fn = vi.fn().mockRejectedValue('string error');

    await expect(
      withRetry(fn, 'test', { maxAttempts: 3, initialDelay: 0, maxDelay: 0 })
    ).rejects.toBe('string error');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('指数バックオフの遅延が maxDelay を超えない（実装検証用）', async () => {
    const delays: number[] = [];
    const origSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(
      (fn: TimerHandler, delay?: number, ...args: unknown[]) => {
        delays.push(delay ?? 0);
        return origSetTimeout(fn as () => void, 0, ...args);
      }
    );

    const err = new Error('rate_limit exceeded');
    const fn = vi
      .fn()
      .mockRejectedValueOnce(err)
      .mockRejectedValueOnce(err)
      .mockResolvedValue('ok');

    await withRetry(fn, 'test', {
      maxAttempts: 3,
      initialDelay: 100,
      maxDelay: 500,
    });

    for (const d of delays) {
      expect(d).toBeLessThanOrEqual(500);
    }

    vi.restoreAllMocks();
  });
});
