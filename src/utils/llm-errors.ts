export class LlmUsageLimitError extends Error {
  constructor(
    public readonly provider: 'claude' | 'codex' | 'gemini',
    message: string
  ) {
    super(message);
    this.name = 'LlmUsageLimitError';
  }
}

const providerLimitReached: Record<string, boolean> = {};

export function markProviderLimitReached(provider: string): void {
  providerLimitReached[provider] = true;
}

export function hasProviderLimitReached(provider: string): boolean {
  return providerLimitReached[provider] === true;
}

export function markClaudeUsageLimitReached(): void {
  markProviderLimitReached('claude');
}

export function hasClaudeUsageLimitReached(): boolean {
  return hasProviderLimitReached('claude');
}

export function isGeminiUsageLimitMessage(value: unknown): boolean {
  const msg = String(value);
  return (
    msg.includes('TerminalQuotaError') ||
    msg.includes('QUOTA_EXHAUSTED') ||
    msg.includes('exhausted your capacity')
  );
}

export function isClaudeUsageLimitMessage(value: unknown): boolean {
  return includesUsageLimitPattern(value);
}

export function isCodexUsageLimitMessage(value: unknown): boolean {
  return includesUsageLimitPattern(value);
}

/**
 * Codex の失敗から、利用上限の判定に使う部分だけを取り出す。
 * Codex の出力には送ったプロンプトのエコーが含まれ、そこに "usage limit" などの語があると
 * 上限と誤判定するため、Codex 自身のエラー行（"ERROR: ..."）だけを見る。
 * エラー行がなければ、プロンプトのエコーを除いた全体を見る。
 */
export function codexFailureText(err: unknown, prompt = ''): string {
  const raw = String(err);
  const errorLines = raw
    .split(/\r?\n/)
    .filter((line) => /^\s*(\[[^\]]*\]\s*)?ERROR\b/.test(line));
  if (errorLines.length > 0) return errorLines.join('\n');
  return prompt ? raw.split(prompt).join('') : raw;
}

export function isCodexUsageLimitError(value: unknown): boolean {
  return (
    value instanceof LlmUsageLimitError &&
    value.provider === 'codex'
  );
}

export function isLlmUsageLimitError(value: unknown): value is LlmUsageLimitError {
  return value instanceof LlmUsageLimitError;
}

function includesUsageLimitPattern(value: unknown): boolean {
  const message = String(value).toLowerCase();
  return [
    // LLM の通常応答にも適用されるため、機能名や数値に一致する語（billing / quota / 429 等）は使わない
    'usage limit',
    // Claude の上限メッセージ "You've hit your limit · resets 2:50pm"（"usage" を含まない）
    "you've hit your limit",
    'rate limit',
    'rate_limit',
    'limit reached',
    'too many requests',
    'credit balance',
    'purchase more credits',
    'quota exceeded',
    'exceeded your current quota',
    'insufficient_quota',
  ].some((pattern) => message.includes(pattern));
}
