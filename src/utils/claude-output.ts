export interface ClaudeResult {
  type: string;
  is_error: boolean;
  result: string;
  session_id: string;
  total_cost_usd?: number;
}

/**
 * claude の標準出力から最終結果（type: "result"）を取り出す。
 * `--output-format stream-json` は 1 行 1 イベントの NDJSON、
 * `--output-format json` は結果オブジェクト 1 つなので、両方を受け付ける。
 */
export function parseClaudeStdout(stdout: string): ClaudeResult {
  try {
    const whole = JSON.parse(stdout);
    if (whole?.type === 'result') return whole as ClaudeResult;
  } catch {
    // NDJSON として扱う
  }

  let last: ClaudeResult | undefined;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const ev = JSON.parse(trimmed);
      if (ev?.type === 'result') last = ev as ClaudeResult;
    } catch {
      // イベントでない行は無視
    }
  }
  if (!last) {
    throw new Error(`Claude output has no result event: ${stdout.substring(0, 300)}`);
  }
  return last;
}
