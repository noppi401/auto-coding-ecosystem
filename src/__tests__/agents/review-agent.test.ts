import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ReviewAgent } from '../../agents/review-agent.js';
import { describeOtherTasks } from '../../utils/other-tasks.js';
import { Task } from '../../state/types.js';

vi.mock('../../utils/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), section: vi.fn() },
}));

const makeTask = (id: string, title: string, targetFiles: string[], testFiles?: string[]): Task => ({
  id,
  title,
  summary: `${title} summary`,
  branchName: `feat/${id}`,
  targetFiles,
  testFiles,
  status: 'pending',
  reviewIteration: 0,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
});

const APPROVED = JSON.stringify({ approved: true, comments: [], summary: 'ok' });

describe('describeOtherTasks()', () => {
  it('現在のタスクを除き、他タスクのタイトルと対象/テストファイルを列挙する', () => {
    const current = makeTask('t1', 'Init', ['package.json']);
    const tasks = [
      current,
      makeTask('t2', 'Server', ['src/server.ts'], ['tests/server.test.ts']),
      makeTask('t3', 'UI', ['public/index.html']),
    ];

    const text = describeOtherTasks(tasks, current);

    expect(text).toContain('Server');
    expect(text).toContain('src/server.ts');
    expect(text).toContain('tests/server.test.ts');
    expect(text).toContain('public/index.html');
    expect(text).not.toContain('package.json');
  });

  it('他タスクが無ければ空文字を返す', () => {
    const current = makeTask('t1', 'Init', ['package.json']);
    expect(describeOtherTasks([current], current)).toBe('');
  });
});

describe('ReviewAgent: 他タスクの計画をレビューに渡す', () => {
  let agent: ReviewAgent;
  let invoke: ReturnType<typeof vi.fn>;
  const task = makeTask('t1', 'Init', ['package.json']);

  beforeEach(() => {
    agent = new ReviewAgent();
    vi.spyOn(agent as any, 'loadSystemPrompt').mockResolvedValue(undefined);
    invoke = vi.spyOn(agent as any, 'invoke').mockResolvedValue(APPROVED) as any;
  });

  it('reviewPr: 他タスクのファイルがプロンプトに含まれる', async () => {
    await agent.reviewPr(task, 'diff', 'req', 'design', '- Server: src/server.ts');

    const prompt = invoke.mock.calls[0][0] as string;
    expect(prompt).toContain('src/server.ts');
    expect(prompt).toMatch(/OTHER PLANNED TASKS/);
  });

  it('reReviewAfterFix: 再レビューでも他タスクのファイルがプロンプトに含まれる', async () => {
    await agent.reReviewAfterFix(task, 'diff', '- Server: src/server.ts');

    const prompt = invoke.mock.calls[0][0] as string;
    expect(prompt).toContain('src/server.ts');
    expect(prompt).toMatch(/OTHER PLANNED TASKS/);
  });

  it('コンテキスト未指定ならセクションを出さない', async () => {
    await agent.reviewPr(task, 'diff', 'req', 'design');

    const prompt = invoke.mock.calls[0][0] as string;
    expect(prompt).not.toMatch(/OTHER PLANNED TASKS/);
  });
});

describe('ReviewAgent: 変更された既存ファイルの全文をレビューに渡す', () => {
  let agent: ReviewAgent;
  let invoke: ReturnType<typeof vi.fn>;
  const task = makeTask('t3', 'Validation', ['server.js']);
  // 実際に起きた誤検知: 定数の定義は差分の外（未変更の行）にあり、差分だけでは「未定義」に見えた
  const fullServer = 'export const MAX_BODY_SIZE = 1024 * 1024;\n// ...\nfunction read() { return MAX_BODY_SIZE; }';

  beforeEach(() => {
    agent = new ReviewAgent();
    vi.spyOn(agent as any, 'loadSystemPrompt').mockResolvedValue(undefined);
    invoke = vi.spyOn(agent as any, 'invoke').mockResolvedValue(APPROVED) as any;
  });

  it('reviewPr: 差分外の定義を含むファイル全文と、未定義判定の前に確認する指示が含まれる', async () => {
    await agent.reviewPr(task, 'diff', 'req', 'design', '', { 'server.js': fullServer });
    const prompt = invoke.mock.calls[0][0] as string;
    expect(prompt).toContain('export const MAX_BODY_SIZE = 1024 * 1024;');
    expect(prompt).toMatch(/before flagging .*undefined/i);
  });

  it('reReviewAfterFix: 同様にファイル全文が含まれる', async () => {
    await agent.reReviewAfterFix(task, 'diff', '', { 'server.js': fullServer });
    expect(invoke.mock.calls[0][0] as string).toContain('export const MAX_BODY_SIZE = 1024 * 1024;');
  });

  it('ファイル全文が無ければ、そのセクションは出さない', async () => {
    await agent.reviewPr(task, 'diff', 'req', 'design', '');
    expect(invoke.mock.calls[0][0] as string).not.toContain('FULL CURRENT CONTENT');
  });
});

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
