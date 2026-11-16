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
