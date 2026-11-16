import { describe, it, expect, vi } from 'vitest';
import { CodingAgent } from '../../agents/coding-agent.js';
import { LlmUsageLimitError } from '../../utils/llm-errors.js';

vi.mock('../../utils/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), section: vi.fn() },
}));

describe('CodingAgent.parseCodeFromResponse', () => {
  it('billing / quota / 429 を含む非JSON応答は usage limit ではなく通常のパースエラーにする（JSON再試行に回す）', () => {
    const agent = new CodingAgent();
    let caught: unknown;
    try {
      agent.parseCodeFromResponse('I implemented the billing page with quota checks and HTTP 429 handling.');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(LlmUsageLimitError);
  });

  it('実際の上限メッセージは LlmUsageLimitError にする', () => {
    const agent = new CodingAgent();
    expect(() => agent.parseCodeFromResponse("You've hit your usage limit. Try again at 3:00 PM."))
      .toThrow(LlmUsageLimitError);
  });
});
