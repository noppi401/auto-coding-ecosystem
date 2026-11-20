import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BaseAgent, StartupStallError } from '../../agents/base-agent.js';

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
const GEMINI_SUCCESS = JSON.stringify({ content: 'Hello from Gemini' });

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

    it('起動時に無反応（StartupStallError）なら再実行し、2回目の成功結果を返す', async () => {
      const agent = new BaseAgent('', 'PlanningAgent');
      const exec = vi
        .spyOn(agent as any, '_execCommand')
        .mockRejectedValueOnce(new StartupStallError('no output'))
        .mockResolvedValueOnce(CLAUDE_SUCCESS);

      const result = await agent.invoke('test message');

      expect(result).toBe('Hello from Claude');
      expect(exec).toHaveBeenCalledTimes(2);
    });

    it('起動時の無反応が上限を超えて続けば、握りつぶさず例外にする', async () => {
      process.env.CLAUDE_STARTUP_RETRIES = '2';
      process.env.FALLBACK_LLM_PROVIDER = 'none';
      const agent = new BaseAgent('', 'PlanningAgent');
      const exec = vi
        .spyOn(agent as any, '_execCommand')
        .mockRejectedValue(new StartupStallError('no output'));

      try {
        await expect(agent.invoke('test message')).rejects.toThrow('no output');
        expect(exec).toHaveBeenCalledTimes(3); // 初回 + リトライ2回
      } finally {
        delete process.env.CLAUDE_STARTUP_RETRIES;
      }
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

    it('claude が is_error の result を出して異常終了したとき、ストリーム全体ではなく result 本文だけをエラーにする（数値の部分一致で上限誤判定しない）', async () => {
      process.env.FALLBACK_LLM_PROVIDER = 'codex';
      const agent = new BaseAgent('', 'CodingAgent');
      // 実際に起きた形: ID や数値（429 等）を含む長いストリームがエラーメッセージに入る
      const stream = [
        JSON.stringify({ type: 'system', subtype: 'init', uuid: 'a429b' }),
        JSON.stringify({
          type: 'result',
          is_error: true,
          result: "API Error: Claude's response exceeded the 32000 output token maximum.",
          session_id: 's429',
        }),
      ].join('\n');
      const err: any = new Error(`Command failed with code 1: ${stream}`);
      err.stdout = stream;
      const exec = vi.spyOn(agent as any, '_execCommand').mockRejectedValue(err);

      await expect(agent.invoke('test message')).rejects.toThrow(/Claude error: API Error.*output token maximum/);
      expect(exec).toHaveBeenCalledTimes(1); // codex へフォールバックしない
    });

    it('claude の出力トークン上限を既定で 64000 に引き上げ、明示設定があればそれを使う', async () => {
      const agent = new BaseAgent('', 'CodingAgent');
      const exec = vi.spyOn(agent as any, '_execCommand').mockResolvedValue(CLAUDE_SUCCESS);
      const prev = process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
      try {
        delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
        await agent.invoke('m');
        expect((exec.mock.calls[0][3] as any).env).toEqual({ CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000' });

        process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = '20000';
        await agent.invoke('m');
        expect((exec.mock.calls[1][3] as any).env).toEqual({ CLAUDE_CODE_MAX_OUTPUT_TOKENS: '20000' });
      } finally {
        if (prev === undefined) delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
        else process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = prev;
      }
    });

    it('claude はツールを一切使えない状態で起動する（ファイル書き込み・外部サービス操作を防ぐ）', async () => {
      const agent = new BaseAgent('', 'CodingAgent');
      const exec = vi.spyOn(agent as any, '_execCommand').mockResolvedValue(CLAUDE_SUCCESS);

      await agent.invoke('test message');

      const args = exec.mock.calls[0][1] as string[];
      expect(args).toContain('--tools='); // ビルトインツール全無効
      expect(args).toContain('--strict-mcp-config'); // MCP（外部サービス）ツールも除外
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

    it('Codex が上限エラーを返したとき Gemini にフォールバックする', async () => {
      process.env.IMPLEMENTATION_LLM_PROVIDER = 'codex';
      process.env.FALLBACK_LLM_PROVIDER = 'gemini';
      const agent = new BaseAgent('', 'CodingAgent');
      const execSpy = vi.spyOn(agent as any, '_execCommand');

      execSpy
        .mockRejectedValueOnce(new Error('usage limit exceeded'))
        .mockResolvedValueOnce(GEMINI_SUCCESS);

      const result = await agent.invoke('test message');

      expect(result).toBe('Hello from Gemini');
      expect(execSpy).toHaveBeenCalledTimes(2);
    });

    it('フォールバック先の Gemini も上限なら例外を投げる', async () => {
      process.env.IMPLEMENTATION_LLM_PROVIDER = 'codex';
      process.env.FALLBACK_LLM_PROVIDER = 'gemini';
      const agent = new BaseAgent('', 'CodingAgent');
      const execSpy = vi.spyOn(agent as any, '_execCommand');

      execSpy
        .mockRejectedValueOnce(new Error('usage limit exceeded'))
        .mockRejectedValueOnce(new Error('TerminalQuotaError: quota exceeded'));

      await expect(agent.invoke('test message')).rejects.toThrow('TerminalQuotaError');
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

  describe('loadSystemPrompt()', () => {
    it('prompts 配下のシステムプロンプトを読み込む', async () => {
      const agent = new BaseAgent('coding.md', 'CodingAgent');

      await agent.loadSystemPrompt();

      expect(agent.getSystemPrompt()).toContain('Coding');
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

    it('前置きの説明文に { } が含まれていても、後ろの ```json ブロックの JSON を取り出す（run 32 の FixAgent 応答）', () => {
      const input = [
        '**Root cause**: `src/index.js` requires `{ createTodoStorage }` from `./storage/todos`, but only `{ TodoStorage }` is exported.',
        '',
        '```json',
        '{"files": [{"path": "src/storage/todos.js", "hunks": []}], "commitMessage": "fix: export factory"}',
        '```',
      ].join('\n');
      const result = (agent as any).robustJsonParse(input);
      expect(result.commitMessage).toBe('fix: export factory');
      expect(result.files[0].path).toBe('src/storage/todos.js');
    });

    it('前置きに ```js などの別言語のコードブロックがあっても、後ろの ```json ブロックの JSON を取り出す（run 35 の FixAgent 応答）', () => {
      const input = [
        'The test most likely destructures the class:',
        '',
        '```js',
        "const { TodoStore } = require('../store');",
        '```',
        '',
        'Currently `store.js` exports only the singleton instance.',
        '',
        '```json',
        '{"files": [{"path": "store.js", "hunks": []}], "commitMessage": "fix: export TodoStore class"}',
        '```',
      ].join('\n');
      const result = (agent as any).robustJsonParse(input);
      expect(result.commitMessage).toBe('fix: export TodoStore class');
      expect(result.files[0].path).toBe('store.js');
    });

    it('二重エスケープされた JSON をパースできる', () => {
      const input = '{\\"key\\": \\"value\\"}';
      const result = (agent as any).robustJsonParse(input);
      expect(result.key).toBe('value');
    });

    // README 等の本文に ``` が含まれる場合、JSON 文字列内のフェンスを誤抽出しない
    const readmeLines = ['# App', '```bash', 'node server.js', '```', 'end'];

    it('純粋な JSON の文字列内に ``` があっても全体をパースできる', () => {
      const input = JSON.stringify({
        files: [{ path: 'README.md', newLines: readmeLines }],
        fixSummary: 'ok',
      });
      const result = (agent as any).robustJsonParse(input);
      expect(result.files[0].newLines).toEqual(readmeLines);
      expect(result.fixSummary).toBe('ok');
    });

    it('```json で囲まれた JSON の文字列内に ``` があっても全体をパースできる', () => {
      const json = JSON.stringify({ files: [{ path: 'README.md', newLines: readmeLines }] });
      const input = '```json\n' + json + '\n```';
      const result = (agent as any).robustJsonParse(input);
      expect(result.files[0].newLines).toEqual(readmeLines);
    });

    it('前置きテキスト + 囲み JSON（内部に ``` あり）もパースできる', () => {
      const json = JSON.stringify({ files: [{ path: 'README.md', newLines: readmeLines }] });
      const input = 'Here is the result:\n```json\n' + json + '\n```\nDone.';
      const result = (agent as any).robustJsonParse(input);
      expect(result.files[0].newLines).toEqual(readmeLines);
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
