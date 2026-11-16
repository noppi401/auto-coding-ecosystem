import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FixAgent } from '../../agents/fix-agent.js';
import { Task, ReviewComment } from '../../state/types.js';

vi.mock('../../utils/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), section: vi.fn() },
}));

const task: Task = {
  id: 't1',
  title: 'Init',
  summary: 'Init summary',
  branchName: 'feat/t1',
  targetFiles: ['package.json'],
  status: 'pending',
  reviewIteration: 0,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const comments: ReviewComment[] = [
  { path: 'package.json', line: 3, body: 'fix test script', severity: 'blocking' },
];

const PACKAGE_JSON = '{\n  "name": "app",\n  "scripts": {\n    "test": "node --test"\n  }\n}';

describe('FixAgent: 行番号付きでファイルを渡す', () => {
  let agent: FixAgent;
  let invoke: ReturnType<typeof vi.fn>;

  const hunkResponse = JSON.stringify({
    files: [{ path: 'package.json', hunks: [{ startLine: 4, endLine: 4, newLines: ['    "test": "node --test tests/*.test.js"'] }] }],
    commitMessage: 'fix: test script',
    fixSummary: 'ok',
  });

  beforeEach(() => {
    agent = new FixAgent();
    vi.spyOn(agent as any, 'loadSystemPrompt').mockResolvedValue(undefined);
    invoke = vi.spyOn(agent as any, 'invoke').mockResolvedValue(hunkResponse) as any;
  });

  it('プロンプトの CURRENT FILES の各行に、1 始まりの行番号が付く', async () => {
    await agent.fixCode(task, comments, { 'package.json': PACKAGE_JSON });

    const prompt = invoke.mock.calls[0][0] as string;
    expect(prompt).toContain('1| {');
    expect(prompt).toContain('2|   "name": "app",');
    expect(prompt).toContain('4|     "test": "node --test"');
    expect(prompt).toContain('6| }');
  });

  it('pr.diff には行番号を付けない（hunk の対象ではないため）', async () => {
    await agent.fixCode(task, comments, { 'package.json': PACKAGE_JSON, 'pr.diff': 'diff --git a/x b/x\n+added' });

    const prompt = invoke.mock.calls[0][0] as string;
    expect(prompt).toContain('FILE: pr.diff\ndiff --git a/x b/x\n+added');
  });

  it('行番号の指す位置どおりに hunk が適用され、JSON として正しいファイルになる', async () => {
    const result = await agent.fixCode(task, comments, { 'package.json': PACKAGE_JSON });

    const fixed = result.files.find((f) => f.path === 'package.json')!.content;
    expect(() => JSON.parse(fixed)).not.toThrow();
    expect(JSON.parse(fixed).scripts.test).toBe('node --test tests/*.test.js');
  });
});
