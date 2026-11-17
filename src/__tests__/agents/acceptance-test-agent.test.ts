import { describe, it, expect, vi, afterEach } from 'vitest';
import { AcceptanceTestAgent } from '../../agents/acceptance-test-agent.js';

vi.mock('../../utils/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), section: vi.fn() },
}));

const task = { id: 'a', title: '受け入れ', summary: 's', branchName: 'feat/task-011-acceptance', targetFiles: ['server.js'], testFiles: ['test/acceptance.test.js'], kind: 'acceptance' } as any;
const PKG = '{\n  "scripts": {\n    "start": "node server.js",\n    "test": "node --test test/api.test.js"\n  }\n}';
const REQ = '- GET / で単一の HTML ページを配信する\n- 無効な JSON は 400 Bad Request';

const response = JSON.stringify({
  files: [
    { path: 'test/acceptance.test.js', lines: ["import test from 'node:test';", "test('GET / は HTML を返す', async () => {});"] },
    { path: 'package.json', hunks: [{ startLine: 4, endLine: 4, newLines: ['    "test": "node --test test/api.test.js test/acceptance.test.js"'] }] },
  ],
  commitMessage: 'test: acceptance',
  prTitle: 't',
  prBody: 'b',
});

describe('AcceptanceTestAgent.generateAcceptanceTests', () => {
  afterEach(() => vi.restoreAllMocks());

  it('要件・ファイル名・起動方法を渡し、実装コードは渡さない', async () => {
    const agent = new AcceptanceTestAgent();
    const invoke = vi.spyOn(agent as any, 'invoke').mockResolvedValue(response);

    await agent.generateAcceptanceTests(task, REQ, PKG, ['server.js', 'public/index.html']);

    const prompt = invoke.mock.calls[0][0] as string;
    expect(prompt).toContain('無効な JSON は 400 Bad Request');
    expect(prompt).toContain('- server.js');
    expect(prompt).toContain('spawn(process.execPath, ["server.js"]');
    expect(prompt).toContain('not shown their contents');
  });

  it('新しいテストファイル（lines）と package.json の変更（hunks）を適用して返す', async () => {
    const agent = new AcceptanceTestAgent();
    vi.spyOn(agent as any, 'invoke').mockResolvedValue(response);

    const out = await agent.generateAcceptanceTests(task, REQ, PKG, ['server.js']);

    expect(out.files.find((f) => f.path === 'test/acceptance.test.js')?.content).toContain("test('GET / は HTML を返す'");
    expect(out.files.find((f) => f.path === 'package.json')?.content).toContain('test/api.test.js test/acceptance.test.js');
  });

  it('IMPLEMENTATION_AGENTS に名前が無くても実装用モデルで動く', async () => {
    const prev = { ...process.env };
    process.env.IMPLEMENTATION_AGENTS = 'CodingAgent,FixAgent';
    process.env.IMPLEMENTATION_LLM_PROVIDER = 'claude';
    process.env.PLANNING_LLM_PROVIDER = 'claude';
    process.env.IMPLEMENTATION_CLAUDE_MODEL = 'impl-model';
    process.env.PLANNING_CLAUDE_MODEL = 'plan-model';
    try {
      const agent = new AcceptanceTestAgent();
      const exec = vi.spyOn(agent as any, '_execCommand').mockResolvedValue(
        JSON.stringify({ type: 'result', is_error: false, result: 'ok', session_id: 's' })
      );
      await agent.invoke('x');
      const args = exec.mock.calls[0][1] as string[];
      expect(args[args.indexOf('--model') + 1]).toBe('impl-model');
    } finally {
      process.env = prev;
    }
  });
});
