import { describe, it, expect, vi } from 'vitest';
import { fetchPrDiffAfterFix } from '../../utils/refetch-diff.js';

const identity = (s: string) => s;
const noSleep = async () => {};

describe('fetchPrDiffAfterFix()', () => {
  it('比較基準が無ければ 1 回だけ取得して返す', async () => {
    const fetchRaw = vi.fn().mockResolvedValue('diff A');

    const result = await fetchPrDiffAfterFix(fetchRaw, null, identity, { sleep: noSleep });

    expect(result).toEqual({ raw: 'diff A', trimmed: 'diff A' });
    expect(fetchRaw).toHaveBeenCalledTimes(1);
  });

  it('1 回目で diff が変わっていれば再取得しない', async () => {
    const fetchRaw = vi.fn().mockResolvedValue('diff B');

    const result = await fetchPrDiffAfterFix(fetchRaw, 'diff A', identity, { sleep: noSleep });

    expect(result.trimmed).toBe('diff B');
    expect(fetchRaw).toHaveBeenCalledTimes(1);
  });

  it('GitHub の反映遅延で古い diff が返っても、変わるまで再取得して新しい diff を返す', async () => {
    const fetchRaw = vi
      .fn()
      .mockResolvedValueOnce('diff A') // push 直後: 古い diff
      .mockResolvedValueOnce('diff A')
      .mockResolvedValueOnce('diff B'); // 反映後
    const sleep = vi.fn(async () => {});

    const result = await fetchPrDiffAfterFix(fetchRaw, 'diff A', identity, { sleep, delayMs: 10 });

    expect(result.trimmed).toBe('diff B');
    expect(fetchRaw).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(10);
  });

  it('再取得しても変わらなければ、上限回数で打ち切って同じ diff を返す', async () => {
    const fetchRaw = vi.fn().mockResolvedValue('diff A');

    const result = await fetchPrDiffAfterFix(fetchRaw, 'diff A', identity, {
      sleep: noSleep,
      retries: 3,
    });

    expect(result.trimmed).toBe('diff A');
    expect(fetchRaw).toHaveBeenCalledTimes(4); // 初回 + 再取得 3 回
  });

  it('比較はトリミング後の diff で行い、raw も併せて返す', async () => {
    const trim = (s: string) => s.replace(/ignored$/, '');
    const fetchRaw = vi
      .fn()
      .mockResolvedValueOnce('diff Aignored')
      .mockResolvedValueOnce('diff B');

    const result = await fetchPrDiffAfterFix(fetchRaw, 'diff A', trim, { sleep: noSleep });

    expect(result).toEqual({ raw: 'diff B', trimmed: 'diff B' });
  });
});
