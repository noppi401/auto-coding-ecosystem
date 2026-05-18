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
    'usage limit',
    'rate limit',
    'quota',
    'credit balance',
    'billing',
    'limit reached',
    'too many requests',
    'purchase more credits',
    'try again at',
    '429',
  ].some((pattern) => message.includes(pattern));
}
