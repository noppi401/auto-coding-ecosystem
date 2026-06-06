import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BaseAgent } from '../../agents/base-agent.js';

vi.mock('../../utils/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), section: vi.fn() },
}));

vi.mock('../../utils/llm-errors.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/llm-errors.js')>();
  return {
    ...actual,
    hasProviderLimitReached: vi.fn().mockReturnValue(false),
    markProviderLimitReached: vi.fn(),
  };
});

vi.mock('../../utils/project-instructions.js', () => ({
  loadCodexProjectInstructions: vi.fn().mockResolvedValue(''),
}));

vi.mock('../../utils/codex-bin.js', () => ({
  resolveCodexBin: vi.fn().mockResolvedValue('codex'),
}));

vi.mock('../../utils/codex-options.js', () => ({
  appendCodexRuntimeArgs: vi.fn(),
  getCodexRuntimeOptions: vi.fn().mockReturnValue({}),
}));

const CLAUDE_SUCCESS = JSON.stringify({
  type: 'result',
  is_error: false,
  result: 'Hello from Claude',
  session_id: 'session-abc',
});

const CODEX_SUCCESS = 'Hello from Codex';

describe('BaseAgent', () => {
  let origEnv: Record<string, string | undefined>;

  beforeEach(() => {
    origEnv = {
      IMPLEMENTATION_LLM_PROVIDER: process.env.IMPLEMENTATION_LLM_PROVIDER,
      PLANNING_LLM_PROVIDER: process.env.PLANNING_LLM_PROVIDER,
      FALLBACK_LLM_PROVIDER: process.env.FALLBACK_LLM_PROVIDER,
      IMPLEMENTATION_AGENTS: process.env.IMPLEMENTATION_AGENTS,
      AI_TOKEN_MODE: process.env.AI_TOKEN_MODE,
      RESUME_AGENT_SESSIONS: process.env.RESUME_AGENT_SESSIONS,
    };
    process.env.IMPLEMENTATION_LLM_PROVIDER = 'claude';
    process.env.FALLBACK_LLM_PROVIDER = 'codex';
    process.env.IMPLEMENTATION_AGENTS = 'CodingAgent,FixAgent';
    delete process.env.AI_TOKEN_MODE;
    delete process.env.RESUME_AGENT_SESSIONS;
  });

  afterEach(async () => {
    Object.entries(origEnv).forEach(([k, v]) => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    });
    vi.clearAllMocks();
    // clearAllMocks clears call history but not mockReturnValue; reset to default
    const { hasProviderLimitReached } = await import('../../utils/llm-errors.js');
    vi.mocked(hasProviderLimitReached).mockReturnValue(false);
  });

  describe('invoke() - claude プロバイダー（正常系）', () => {
    it('Claude の JSON 出力をパースして result を返す', async () => {
      const agent = new BaseAgent('', 'PlanningAgent');
      vi.spyOn(agent as any, '_execCommand').mockResolvedValue(CLAUDE_SUCCESS);

      const result = await agent.invoke('test message');

      expect(result).toBe('Hello from Claude');
    });

    it('sessionId が output.session_id に更新される', async () => {
      const agent = new BaseAgent('', 'PlanningAgent');
      vi.spyOn(agent as any, '_execCommand').mockResolvedValue(CLAUDE_SUCCESS);

      await agent.invoke('test message');

      expect(agent.getSessionId()).toBe('session-abc');
    });

    it('is_error=true の場合は例外をスローする', async () => {
      const agent = new BaseAgent('', 'PlanningAgent');
      vi.spyOn(agent as any, '_execCommand').mockResolvedValue(
        JSON.stringify({
          type: 'result',
          is_error: true,
          result: 'something went wrong',
          session_id: 'session-err',
        })
      );

      await expect(agent.invoke('test message')).rejects.toThrow('Claude error');
    });
  });

  describe('invoke() - フォールバック（使用量上限エラー）', () => {
    it('Claude が usage limit エラーを返したとき codex にフォールバックする', async () => {
      const { isClaudeUsageLimitMessage, LlmUsageLimitError } =
        await import('../../utils/llm-errors.js');

      const agent = new BaseAgent('', 'PlanningAgent');
      const execSpy = vi.spyOn(agent as any, '_execCommand');

      execSpy
        .mockRejectedValueOnce(new Error('usage limit exceeded'))
        .mockResolvedValue(CODEX_SUCCESS);

      const result = await agent.invoke('test message');

      expect(result).toBe(CODEX_SUCCESS);
      expect(execSpy).toHaveBeenCalledTimes(2);
    });

    it('claude の上限が既にマーク済みのとき codex を直接呼び出す', async () => {
      const { hasProviderLimitReached } = await import('../../utils/llm-errors.js');
      vi.mocked(hasProviderLimitReached).mockReturnValue(true);

      const agent = new BaseAgent('', 'PlanningAgent');
      const execSpy = vi.spyOn(agent as any, '_execCommand').mockResolvedValue(CODEX_SUCCESS);

      const result = await agent.invoke('test message');

      expect(result).toBe(CODEX_SUCCESS);
      expect(execSpy).toHaveBeenCalledTimes(1);
    });

    it('サポートされていないプロバイダーは例外をスローする', async () => {
      process.env.IMPLEMENTATION_LLM_PROVIDER = 'unsupported-provider';
      const agent = new BaseAgent('', 'CodingAgent'); // CodingAgent uses IMPLEMENTATION_LLM_PROVIDER

      await expect(agent.invoke('test')).rejects.toThrow('Unsupported LLM provider');
    });
  });

  describe('invoke() - 実装ルート vs 計画ルートのプロバイダー選択', () => {
    it('CodingAgent は IMPLEMENTATION_LLM_PROVIDER を使う', async () => {
      process.env.IMPLEMENTATION_LLM_PROVIDER = 'claude';
      const agent = new BaseAgent('', 'CodingAgent');
      const execSpy = vi.spyOn(agent as any, '_execCommand').mockResolvedValue(CLAUDE_SUCCESS);

      await agent.invoke('test');

      const firstCall = execSpy.mock.calls[0];
      expect(firstCall[0]).toBe('claude');
    });

    it('PlanningAgent は PLANNING_LLM_PROVIDER を使う', async () => {
      process.env.PLANNING_LLM_PROVIDER = 'claude';
      const agent = new BaseAgent('', 'PlanningAgent');
      const execSpy = vi.spyOn(agent as any, '_execCommand').mockResolvedValue(CLAUDE_SUCCESS);

      await agent.invoke('test');

      const firstCall = execSpy.mock.calls[0];
      expect(firstCall[0]).toBe('claude');
    });
  });

  describe('setModelOverride()', () => {
    it('実装エージェントはモデル上書きが claude 引数に反映される', async () => {
      const agent = new BaseAgent('', 'CodingAgent');
      agent.setModelOverride('claude-haiku-4-5-20251001');

      const execSpy = vi.spyOn(agent as any, '_execCommand').mockResolvedValue(CLAUDE_SUCCESS);
      await agent.invoke('test');

      const args = execSpy.mock.calls[0][1] as string[];
      const modelIdx = args.indexOf('--model');
      expect(modelIdx).toBeGreaterThan(-1);
      expect(args[modelIdx + 1]).toBe('claude-haiku-4-5-20251001');
    });
  });

  describe('robustJsonParse()', () => {
    let agent: BaseAgent;

    beforeEach(() => {
      agent = new BaseAgent('', 'TestAgent');
    });

    it('正常な JSON をパースできる', () => {
      const result = (agent as any).robustJsonParse('{"key": "value"}');
      expect(result.key).toBe('value');
    });

    it('Markdown コードブロックから JSON を抽出する', () => {
      const input = '```json\n{"key": "value"}\n```';
      const result = (agent as any).robustJsonParse(input);
      expect(result.key).toBe('value');
    });

    it('前後のテキストをスキップして JSON を抽出する', () => {
      const input = 'Some preamble text\n{"key": "value"}\nSome postamble';
      const result = (agent as any).robustJsonParse(input);
      expect(result.key).toBe('value');
    });

    it('不正な JSON は例外をスローする', () => {
      expect(() => (agent as any).robustJsonParse('not json at all')).toThrow();
    });

    it('二重エスケープされた JSON をパースできる', () => {
      const input = '{\\"key\\": \\"value\\"}';
      const result = (agent as any).robustJsonParse(input);
      expect(result.key).toBe('value');
    });
  });

  describe('getSessionId() / setSessionId()', () => {
    it('初期値は null', () => {
      const agent = new BaseAgent();
      expect(agent.getSessionId()).toBeNull();
    });

    it('setSessionId で値を設定できる', () => {
      const agent = new BaseAgent();
      agent.setSessionId('test-session-id');
      expect(agent.getSessionId()).toBe('test-session-id');
    });
  });
});
