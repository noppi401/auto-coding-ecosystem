import { describe, it, expect } from 'vitest';
import {
  LlmUsageLimitError,
  markProviderLimitReached,
  hasProviderLimitReached,
  markClaudeUsageLimitReached,
  hasClaudeUsageLimitReached,
  isClaudeUsageLimitMessage,
  isCodexUsageLimitMessage,
  isGeminiUsageLimitMessage,
  isCodexUsageLimitError,
  isLlmUsageLimitError,
} from '../../utils/llm-errors.js';

describe('LlmUsageLimitError', () => {
  it('Error を継承し、name と provider を持つ', () => {
    const err = new LlmUsageLimitError('claude', 'limit reached');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('LlmUsageLimitError');
    expect(err.provider).toBe('claude');
    expect(err.message).toBe('limit reached');
  });
});

describe('markProviderLimitReached / hasProviderLimitReached', () => {
  it('未マークのプロバイダーは false を返す', () => {
    expect(hasProviderLimitReached('test-provider-unknown-abc')).toBe(false);
  });

  it('マーク後は true を返す', () => {
    const provider = `test-provider-${Date.now()}`;
    expect(hasProviderLimitReached(provider)).toBe(false);
    markProviderLimitReached(provider);
    expect(hasProviderLimitReached(provider)).toBe(true);
  });
});

describe('markClaudeUsageLimitReached / hasClaudeUsageLimitReached', () => {
  it('Claude 専用のマーク/チェックが機能する', () => {
    const before = hasClaudeUsageLimitReached();
    markClaudeUsageLimitReached();
    expect(hasClaudeUsageLimitReached()).toBe(true);
    // (一度マークされると永続するため、before が false だった場合のみ厳密チェック)
    if (!before) {
      expect(hasClaudeUsageLimitReached()).toBe(true);
    }
  });
});

describe('isClaudeUsageLimitMessage', () => {
  it.each([
    'usage limit reached',
    'Claude usage limit',
    'rate limit exceeded',
    'credit balance insufficient',
    'limit reached',
    'too many requests',
    'purchase more credits',
    '429 Too Many Requests',
    'You exceeded your current quota, please check your plan and billing details.',
    'insufficient_quota',
    'Quota exceeded. Check your plan and billing details.',
    'rate_limit_error',
    "You've hit your usage limit. Try again at 3:00 PM.",
    // run 35 で実際に返った Claude の上限メッセージ（"usage" を含まない）
    "Claude error: You've hit your limit · resets 2:50pm (Asia/Tokyo)",
  ])('"%s" → true', (msg) => {
    expect(isClaudeUsageLimitMessage(msg)).toBe(true);
  });

  it.each([
    'internal server error',
    'invalid request',
    'authentication failed',
    'feat: add billing page',
    'handle quota overflow',
    'src/a.ts:429',
    'retry after 429ms',
  ])('"%s" → false', (msg) => {
    expect(isClaudeUsageLimitMessage(msg)).toBe(false);
  });
});

describe('isCodexUsageLimitMessage', () => {
  it('usage limit メッセージを検出する', () => {
    expect(isCodexUsageLimitMessage('usage limit exceeded')).toBe(true);
  });

  it('無関係なメッセージは false', () => {
    expect(isCodexUsageLimitMessage('compilation error')).toBe(false);
  });
});

describe('isGeminiUsageLimitMessage', () => {
  it.each([
    'TerminalQuotaError occurred',
    'QUOTA_EXHAUSTED for this project',
    'you have exhausted your capacity',
  ])('"%s" → true', (msg) => {
    expect(isGeminiUsageLimitMessage(msg)).toBe(true);
  });

  it.each([
    'network error',
    'invalid api key',
  ])('"%s" → false', (msg) => {
    expect(isGeminiUsageLimitMessage(msg)).toBe(false);
  });
});

describe('isCodexUsageLimitError', () => {
  it('LlmUsageLimitError(codex) → true', () => {
    const err = new LlmUsageLimitError('codex', 'limit');
    expect(isCodexUsageLimitError(err)).toBe(true);
  });

  it('LlmUsageLimitError(claude) → false', () => {
    const err = new LlmUsageLimitError('claude', 'limit');
    expect(isCodexUsageLimitError(err)).toBe(false);
  });

  it('通常の Error → false', () => {
    expect(isCodexUsageLimitError(new Error('limit'))).toBe(false);
  });
});

describe('isLlmUsageLimitError', () => {
  it('LlmUsageLimitError は true', () => {
    const err = new LlmUsageLimitError('gemini', 'limit');
    expect(isLlmUsageLimitError(err)).toBe(true);
  });

  it('通常の Error は false', () => {
    expect(isLlmUsageLimitError(new Error('limit'))).toBe(false);
  });

  it('文字列は false', () => {
    expect(isLlmUsageLimitError('limit')).toBe(false);
  });
});
