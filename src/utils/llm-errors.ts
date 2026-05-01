export class LlmUsageLimitError extends Error {
  constructor(
    public readonly provider: 'claude' | 'codex',
    message: string
  ) {
    super(message);
    this.name = 'LlmUsageLimitError';
  }
}

let claudeUsageLimitReached = false;

export function markClaudeUsageLimitReached(): void {
  claudeUsageLimitReached = true;
}

export function hasClaudeUsageLimitReached(): boolean {
  return claudeUsageLimitReached;
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
