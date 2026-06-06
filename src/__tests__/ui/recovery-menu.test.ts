import { describe, it, expect } from 'vitest';
import { visibleTaskChecks } from '../../ui/components/RecoveryMenu.js';
import type { Task } from '../../state/types.js';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Task',
    summary: 'Summary',
    branchName: 'feat/task',
    targetFiles: [],
    status: 'failed',
    reviewIteration: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('visibleTaskChecks', () => {
  it('passed は表示対象から除外し、失敗・警告・skipだけを返す', () => {
    const task = makeTask({
      lastChecks: [
        { name: 'typescript', status: 'passed', summary: 'ok', updatedAt: '2026-01-01T00:00:00.000Z' },
        { name: 'test', status: 'failed', summary: 'failed', updatedAt: '2026-01-01T00:01:00.000Z' },
        { name: 'coverage', status: 'warning', summary: 'warning', updatedAt: '2026-01-01T00:02:00.000Z' },
      ],
    });

    expect(visibleTaskChecks(task).map((check) => check.name)).toEqual(['test', 'coverage']);
  });

  it('表示件数は最新4件に制限する', () => {
    const task = makeTask({
      lastChecks: [
        { name: 'typescript', status: 'failed', summary: '1', updatedAt: '2026-01-01T00:00:00.000Z' },
        { name: 'install', status: 'failed', summary: '2', updatedAt: '2026-01-01T00:01:00.000Z' },
        { name: 'test', status: 'failed', summary: '3', updatedAt: '2026-01-01T00:02:00.000Z' },
        { name: 'coverage', status: 'warning', summary: '4', updatedAt: '2026-01-01T00:03:00.000Z' },
        { name: 'build-gate', status: 'failed', summary: '5', updatedAt: '2026-01-01T00:04:00.000Z' },
      ],
    });

    expect(visibleTaskChecks(task).map((check) => check.name)).toEqual([
      'install',
      'test',
      'coverage',
      'build-gate',
    ]);
  });
});
