import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CodexAgent } from '../../agents/codex-agent.js';

vi.mock('../../utils/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), section: vi.fn() },
}));

describe('CodexAgent', () => {
  let origEnv: Record<string, string | undefined>;

  beforeEach(() => {
    origEnv = {
      CODEX_TIMEOUT_MS: process.env.CODEX_TIMEOUT_MS,
      AGENT_COMMAND_TIMEOUT_MS: process.env.AGENT_COMMAND_TIMEOUT_MS,
      CODEX_MODEL: process.env.CODEX_MODEL,
      CODEX_USE_OSS: process.env.CODEX_USE_OSS,
      CODEX_LOCAL_PROVIDER: process.env.CODEX_LOCAL_PROVIDER,
    };
    delete process.env.CODEX_TIMEOUT_MS;
    delete process.env.AGENT_COMMAND_TIMEOUT_MS;
    delete process.env.CODEX_MODEL;
    delete process.env.CODEX_USE_OSS;
    delete process.env.CODEX_LOCAL_PROVIDER;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(origEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('CODEX_TIMEOUT_MS が未指定なら AGENT_COMMAND_TIMEOUT_MS を使う', () => {
    process.env.AGENT_COMMAND_TIMEOUT_MS = '12345';
    const agent = new CodexAgent();

    expect((agent as any).resolveCodexTimeoutMs()).toBe(12345);
  });

  it('CODEX_TIMEOUT_MS があれば AGENT_COMMAND_TIMEOUT_MS より優先する', () => {
    process.env.AGENT_COMMAND_TIMEOUT_MS = '12345';
    process.env.CODEX_TIMEOUT_MS = '2345';
    const agent = new CodexAgent();

    expect((agent as any).resolveCodexTimeoutMs()).toBe(2345);
  });

  it('タイムアウト時に provider / model / operation / timeout を含む', async () => {
    process.env.CODEX_TIMEOUT_MS = '25';
    process.env.CODEX_MODEL = 'gpt-test';
    const agent = new CodexAgent();

    await expect(
      (agent as any).execCodex(
        process.execPath,
        ['-e', 'setTimeout(() => {}, 1000);'],
        '',
        'reviewPr'
      )
    ).rejects.toThrow(
      'Codex command timeout: provider=codex, model=gpt-test, operation=reviewPr, timeout=0.025s'
    );
  });
});
