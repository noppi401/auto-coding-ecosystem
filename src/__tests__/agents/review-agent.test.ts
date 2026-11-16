import { describe, it, expect, vi } from 'vitest';
import { ReviewAgent } from '../../agents/review-agent.js';

vi.mock('../../utils/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), section: vi.fn() },
}));

describe('ReviewAgent.parseReviewFromResponse', () => {
  it('severity の欠落・想定外の値は blocking、suggestion は大小文字を問わず suggestion に正規化する', () => {
    const agent = new ReviewAgent();
    const result = agent.parseReviewFromResponse(JSON.stringify({
      approved: true,
      comments: [
        { path: 'a.ts', line: 1, body: 'missing' },
        { path: 'b.ts', line: 2, body: 'upper', severity: 'Blocking' },
        { path: 'c.ts', line: 3, body: 'unknown', severity: 'critical' },
        { path: 'd.ts', line: 4, body: 'nit', severity: 'Suggestion' },
      ],
      summary: 's',
    }));

    expect(result.comments.map((c) => c.severity)).toEqual(['blocking', 'blocking', 'blocking', 'suggestion']);
  });
});
