import { describe, it, expect, vi } from 'vitest';
import { TaskDecompAgent } from '../../agents/task-decomp-agent.js';

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
