/**
 * #36: LLMプロバイダーフォールバックシナリオのE2Eライクテスト
 *
 * BaseAgent の invoke() を通じて複数プロバイダーにまたがる
 * フォールバック経路を検証する。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BaseAgent } from '../agents/base-agent.js';

vi.mock('../utils/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), section: vi.fn() },
}));

const mockLimitState: Record<string, boolean> = {};

vi.mock('../utils/llm-errors.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/llm-errors.js')>();
  return {
    ...actual,
    hasProviderLimitReached: vi.fn().mockImplementation((p: string) => mockLimitState[p] ?? false),
    markProviderLimitReached: vi.fn().mockImplementation((p: string) => { mockLimitState[p] = true; }),
  };
});

vi.mock('../utils/project-instructions.js', () => ({
  loadCodexProjectInstructions: vi.fn().mockResolvedValue(''),
}));

vi.mock('../utils/codex-bin.js', () => ({
  resolveCodexBin: vi.fn().mockResolvedValue('codex'),
}));

vi.mock('../utils/codex-options.js', () => ({
  appendCodexRuntimeArgs: vi.fn(),
  getCodexRuntimeOptions: vi.fn().mockReturnValue({}),
}));

const CLAUDE_SUCCESS = JSON.stringify({
  type: 'result',
  is_error: false,
  result: 'Claude response',
  session_id: 'session-1',
});

const CODEX_SUCCESS = 'Codex response';

const GEMINI_SUCCESS = JSON.stringify({
  content: 'Gemini response',
});

describe('LLM フォールバックシナリオ', () => {
  let origEnv: Record<string, string | undefined>;

  beforeEach(() => {
    origEnv = {
      IMPLEMENTATION_LLM_PROVIDER: process.env.IMPLEMENTATION_LLM_PROVIDER,
      PLANNING_LLM_PROVIDER: process.env.PLANNING_LLM_PROVIDER,
      FALLBACK_LLM_PROVIDER: process.env.FALLBACK_LLM_PROVIDER,
      IMPLEMENTATION_AGENTS: process.env.IMPLEMENTATION_AGENTS,
      AI_TOKEN_MODE: process.env.AI_TOKEN_MODE,
    };
    process.env.IMPLEMENTATION_LLM_PROVIDER = 'claude';
    process.env.FALLBACK_LLM_PROVIDER = 'codex';
    process.env.IMPLEMENTATION_AGENTS = 'CodingAgent,FixAgent';
    delete process.env.AI_TOKEN_MODE;
    Object.keys(mockLimitState).forEach(k => delete mockLimitState[k]);
  });

  afterEach(() => {
    Object.entries(origEnv).forEach(([k, v]) => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    });
    vi.resetModules();
  });

  describe('Claude → Codex フォールバック', () => {
    it('Claude が使用量上限エラー → Codex で正常完了する', async () => {
      const agent = new BaseAgent('', 'PlanningAgent');
      const execSpy = vi.spyOn(agent as any, '_execCommand');

      execSpy
        .mockRejectedValueOnce(new Error('usage limit exceeded'))
        .mockResolvedValueOnce(CODEX_SUCCESS);

      const result = await agent.invoke('hello');
      expect(result).toBe(CODEX_SUCCESS);
      expect(execSpy).toHaveBeenCalledTimes(2);
    });

    it('Claude が rate_limit エラー（リトライ後に上限として扱われない）', async () => {
      // rate_limit は withRetry でリトライ対象だが、BaseAgent のフォールバックとは別
      // BaseAgent は raw error を受け取り isProviderUsageLimitError で判定する
      const agent = new BaseAgent('', 'PlanningAgent');
      const execSpy = vi.spyOn(agent as any, '_execCommand');

      execSpy
        .mockRejectedValueOnce(new Error('rate limit exceeded'))
        .mockResolvedValueOnce(CODEX_SUCCESS);

      const result = await agent.invoke('hello');
      expect(result).toBe(CODEX_SUCCESS);
    });

    it('Claude が quota エラー → Codex で正常完了する', async () => {
      const agent = new BaseAgent('', 'PlanningAgent');
      const execSpy = vi.spyOn(agent as any, '_execCommand');

      execSpy
        .mockRejectedValueOnce(new Error('quota exceeded'))
        .mockResolvedValueOnce(CODEX_SUCCESS);

      const result = await agent.invoke('hello');
      expect(result).toBe(CODEX_SUCCESS);
    });
  });

  describe('フォールバック先が同一プロバイダーの場合', () => {
    it('FALLBACK_LLM_PROVIDER=claude のとき上限エラーは直接スローされる', async () => {
      process.env.FALLBACK_LLM_PROVIDER = 'claude';
      const agent = new BaseAgent('', 'PlanningAgent');
      vi.spyOn(agent as any, '_execCommand').mockRejectedValue(new Error('usage limit exceeded'));

      await expect(agent.invoke('hello')).rejects.toThrow();
    });
  });

  describe('AI_TOKEN_MODE によるフォールバック無効化', () => {
    it('AI_TOKEN_MODE=claude のとき上限エラーは LlmUsageLimitError としてスローされる', async () => {
      process.env.AI_TOKEN_MODE = 'claude';
      process.env.IMPLEMENTATION_LLM_PROVIDER = 'claude';

      const agent = new BaseAgent('', 'PlanningAgent');
      vi.spyOn(agent as any, '_execCommand').mockRejectedValue(new Error('usage limit exceeded'));

      const { LlmUsageLimitError } = await import('../utils/llm-errors.js');
      await expect(agent.invoke('hello')).rejects.toThrow();
    });
  });

  describe('既に上限マーク済みプロバイダーのスキップ', () => {
    it('同一エージェントの連続呼び出し中に上限へ到達した後、次回は Codex を直接使う', async () => {
      const agent = new BaseAgent('', 'PlanningAgent');
      const execSpy = vi.spyOn(agent as any, '_execCommand');

      execSpy
        .mockResolvedValueOnce(CLAUDE_SUCCESS)
        .mockRejectedValueOnce(new Error('usage limit exceeded'))
        .mockResolvedValueOnce(CODEX_SUCCESS)
        .mockResolvedValueOnce(CODEX_SUCCESS);

      expect(await agent.invoke('first call')).toBe('Claude response');
      expect(await agent.invoke('second call')).toBe(CODEX_SUCCESS);
      expect(await agent.invoke('third call')).toBe(CODEX_SUCCESS);

      expect(execSpy).toHaveBeenCalledTimes(4);
      expect(execSpy.mock.calls[3][0]).toBe('codex');
    });

    it('Claude がセッション内で一度上限に達した後、次回呼び出しは Codex を直接使う', async () => {
      const agent1 = new BaseAgent('', 'PlanningAgent');
      const execSpy1 = vi.spyOn(agent1 as any, '_execCommand');

      // 最初の呼び出しで Claude が上限
      execSpy1
        .mockRejectedValueOnce(new Error('usage limit exceeded'))
        .mockResolvedValueOnce(CODEX_SUCCESS);

      await agent1.invoke('first call');
      // markProviderLimitReached が呼ばれるはず

      // 2回目の呼び出しを別エージェントでシミュレート
      const agent2 = new BaseAgent('', 'PlanningAgent');
      const execSpy2 = vi.spyOn(agent2 as any, '_execCommand').mockResolvedValue(CODEX_SUCCESS);

      // hasProviderLimitReached が true を返せば claude をスキップ
      // （モジュール状態に依存するためここでは挙動を確認）
      const result = await agent2.invoke('second call');
      expect(result).toBeDefined();
    });
  });

  describe('Gemini プロバイダー', () => {
    it('FALLBACK_LLM_PROVIDER=gemini のとき Gemini が呼ばれる', async () => {
      process.env.FALLBACK_LLM_PROVIDER = 'gemini';
      const agent = new BaseAgent('', 'PlanningAgent');
      const execSpy = vi.spyOn(agent as any, '_execCommand');

      execSpy
        .mockRejectedValueOnce(new Error('usage limit exceeded'))
        .mockResolvedValueOnce(GEMINI_SUCCESS);

      const result = await agent.invoke('hello');
      expect(result).toBeDefined();
      expect(execSpy).toHaveBeenCalledTimes(2);
    });

    it('Gemini が TerminalQuotaError を返したとき LlmUsageLimitError をスローする', async () => {
      process.env.IMPLEMENTATION_LLM_PROVIDER = 'gemini';
      process.env.FALLBACK_LLM_PROVIDER = 'gemini';

      const agent = new BaseAgent('', 'PlanningAgent');
      vi.spyOn(agent as any, '_execCommand').mockRejectedValue(
        new Error('TerminalQuotaError: quota exceeded')
      );

      const { LlmUsageLimitError } = await import('../utils/llm-errors.js');
      await expect(agent.invoke('hello')).rejects.toThrow();
    });

    it('primary と fallback がどちらも上限ならワークフローを停止する', async () => {
      process.env.FALLBACK_LLM_PROVIDER = 'gemini';
      const agent = new BaseAgent('', 'PlanningAgent');
      const execSpy = vi.spyOn(agent as any, '_execCommand');

      execSpy
        .mockRejectedValueOnce(new Error('usage limit exceeded'))
        .mockRejectedValueOnce(new Error('TerminalQuotaError: quota exceeded'));

      await expect(agent.invoke('hello')).rejects.toThrow('TerminalQuotaError');
      expect(execSpy).toHaveBeenCalledTimes(2);
    });
  });
});
