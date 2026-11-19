import { describe, it, expect, vi, afterEach } from 'vitest';
import { TaskDecompAgent } from '../../agents/task-decomp-agent.js';
import { logger } from '../../utils/logger.js';

vi.mock('../../utils/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), section: vi.fn() },
}));

describe('TaskDecompAgent.parseTasksFromResponse: テストファイルの共有を解消する', () => {
  it('同じテストファイルを指す後続タスクには、専用のテストファイルを割り当てる', () => {
    const agent = new TaskDecompAgent();
    const response = JSON.stringify([
      { title: 'Server', summary: 's', branchName: 'feat/task-002-server', targetFiles: ['server.js'], testFiles: ['test/api.test.js'] },
      { title: 'GET', summary: 's', branchName: 'feat/task-005-get', targetFiles: ['server.js'], testFiles: ['test/api.test.js'] },
    ]);

    const tasks = agent.parseTasksFromResponse(response);

    expect(tasks.map((t) => t.testFiles)).toEqual([['test/api.test.js'], ['test/task-005-get.test.js']]);
  });

  it('設定ファイルだけを作るタスクが後ろにあれば、先頭に移す', () => {
    const agent = new TaskDecompAgent();
    const response = JSON.stringify([
      { title: 'Server', summary: 's', branchName: 'feat/task-001-server', targetFiles: ['src/server.js'], testFiles: ['test/server.test.js'] },
      { title: 'Config', summary: 's', branchName: 'feat/task-002-config', targetFiles: ['package.json', 'README.md'], testFiles: ['test/config.test.js'] },
    ]);

    const tasks = agent.parseTasksFromResponse(response);

    expect(tasks.map((t) => t.title)).toEqual(['Config', 'Server']);
  });
});

describe('TaskDecompAgent.decomposeTask', () => {
  const tail = 'TAIL_REQUIREMENT_MARKER';
  const requirementsDoc = `${'x'.repeat(10000)}${tail}`;

  afterEach(() => {
    delete process.env.TASK_DECOMP_REQ_DOC_MAX_CHARS;
    vi.clearAllMocks();
  });

  function setup() {
    const agent = new TaskDecompAgent();
    vi.spyOn(agent, 'loadSystemPrompt').mockResolvedValue();
    const invoke = vi.spyOn(agent, 'invoke').mockResolvedValue('[{"title":"t","summary":"s","branchName":"feat/t","targetFiles":[]}]');
    return { agent, invoke };
  }

  it('既定では要件定義を切り詰めず全文を渡す', async () => {
    const { agent, invoke } = setup();
    await agent.decomposeTask(requirementsDoc, 'design');
    expect(invoke.mock.calls[0][0]).toContain(tail);
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('truncated'), expect.anything());
  });

  it('TASK_DECOMP_REQ_DOC_MAX_CHARS 指定時は切り詰め、警告ログを出す', async () => {
    process.env.TASK_DECOMP_REQ_DOC_MAX_CHARS = '6000';
    const { agent, invoke } = setup();
    await agent.decomposeTask(requirementsDoc, 'design');
    expect(invoke.mock.calls[0][0]).not.toContain(tail);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('TaskDecompAgent requirements truncated'), expect.any(String));
  });
});
