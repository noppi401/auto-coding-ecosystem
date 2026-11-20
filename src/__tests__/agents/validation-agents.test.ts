import { describe, it, expect, vi } from 'vitest';
import { RequirementsValidationAgent } from '../../agents/requirements-validation-agent.js';
import { DesignValidationAgent } from '../../agents/design-validation-agent.js';

vi.mock('../../utils/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), section: vi.fn() },
}));

// run 34: 文字列を閉じる引用符を誤ってエスケープした（。\",）JSON で、パースに失敗して 0 点と誤判定された
// 実際の応答と同じく、正しいエスケープ（\"x\"）と誤った閉じ引用符のエスケープ（。\",）が混在し、既存の補正でも読めない
const BROKEN = '{"score": 75, "grade": "B", "issues": ["例：`node -e \\"x\\"` で確認』。\\", "b"], "recommendations": []}';
const VALID = JSON.stringify({ score: 82, grade: 'B', categories: {}, summary: 'ok', issues: [], recommendations: [] });

describe.each([
  ['RequirementsValidationAgent', () => new RequirementsValidationAgent(), (a: any) => a.validate('req', 'instruction')],
  ['DesignValidationAgent', () => new DesignValidationAgent(), (a: any) => a.validate('design', 'req')],
])('%s: JSON が読めなければ 1 回だけ呼び直す', (_name, make, run) => {
  it('1 回目が壊れた JSON でも、呼び直しの結果を採用する（0 点と誤判定しない）', async () => {
    const agent: any = make();
    vi.spyOn(agent, 'loadSystemPrompt').mockResolvedValue(undefined);
    const invoke = vi.spyOn(agent, 'invoke').mockResolvedValueOnce(BROKEN).mockResolvedValueOnce(VALID);

    const result = await run(agent);

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[1][0]).toMatch(/not valid JSON/);
    expect(result.score).toBe(82);
  });

  it('呼び直しても読めなければ、従来どおりパース失敗の結果を返す（隠さない）', async () => {
    const agent: any = make();
    vi.spyOn(agent, 'loadSystemPrompt').mockResolvedValue(undefined);
    vi.spyOn(agent, 'invoke').mockResolvedValue(BROKEN);

    const result = await run(agent);

    expect(result.score).toBe(0);
    expect(result.summary).toContain('パース');
  });
});
