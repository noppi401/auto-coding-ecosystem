const DEFAULT_RETRIES = 4;
const DEFAULT_DELAY_MS = 3000;

export interface RefetchOptions {
  retries?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

function resolveDelayMs(): number {
  const raw = process.env.PR_DIFF_REFETCH_DELAY_MS;
  if (raw === undefined) return DEFAULT_DELAY_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_DELAY_MS;
}

/**
 * 修正コミットを push した直後の PR diff を取得する。
 *
 * push 直後は `gh pr diff` が GitHub 側の反映前の古い diff を返すことがあり、
 * 実際には修正が入っているのに「diff が変わらない」と誤判定してレビューループを
 * 中断していた。`previous`（修正前の diff）と同じ内容が返る間は短い間隔で再取得し、
 * 上限回数を超えても変わらなければ、その diff をそのまま返す（真に変化なしとして扱う）。
 *
 * `previous` が null（修正が無かった／初回）のときは 1 回だけ取得する。
 */
export async function fetchPrDiffAfterFix(
  fetchRaw: () => Promise<string>,
  previous: string | null,
  trim: (diff: string) => string,
  options: RefetchOptions = {}
): Promise<{ raw: string; trimmed: string }> {
  const retries = options.retries ?? DEFAULT_RETRIES;
  const delayMs = options.delayMs ?? resolveDelayMs();
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let raw = await fetchRaw();
  let trimmed = trim(raw);

  for (let i = 0; previous !== null && trimmed === previous && i < retries; i++) {
    await sleep(delayMs);
    raw = await fetchRaw();
    trimmed = trim(raw);
  }

  return { raw, trimmed };
}
