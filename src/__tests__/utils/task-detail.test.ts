import { describe, it, expect } from 'vitest';
import { formatTaskDetail } from '../../utils/task-detail.js';
import type { Task } from '../../state/types.js';

const makeTask = (over: Partial<Task> = {}): Task => ({
  id: 't',
  title: 'Task',
  summary: '',
  branchName: 'feat/t',
  targetFiles: [],
  status: 'pending',
  reviewIteration: 0,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...over,
});

describe('formatTaskDetail: 状態一覧の DETAIL 欄', () => {
  it('スキップしたタスクは、スキップの理由を出す（ace-test-todo-en2 では "-" になっていた）', () => {
    const task = makeTask({
      status: 'skipped',
      errorMessage: 'Skipped as already implemented: index.html already contains the UI',
    });

    // 60 文字に切り詰める（既存の失敗時の表示と同じ）
    expect(formatTaskDetail(task)).toBe('Skipped as already implemented: index.html already contai...');
  });

  it('スキップしたタスクは、前の失敗で残ったチェック結果より理由を優先する', () => {
    const task = makeTask({
      status: 'skipped',
      errorMessage: 'Skipped as already implemented: x',
      lastChecks: [{ name: 'tests', status: 'failed', summary: 'old failure' } as any],
    });

    expect(formatTaskDetail(task)).toBe('Skipped as already implemented: x');
  });

  it('失敗したタスクは、これまでどおりチェック結果がなければエラーメッセージを出す', () => {
    expect(formatTaskDetail(makeTask({ status: 'failed', errorMessage: 'boom\n  happened' }))).toBe('boom happened');
  });

  it('マージ済みのタスクは、これまでどおり失敗以外のチェック結果やレビュー回数を出す', () => {
    const withCheck = makeTask({
      status: 'merged',
      lastChecks: [{ name: 'coverage', status: 'skipped', summary: 'not enabled' } as any],
    });
    expect(formatTaskDetail(withCheck)).toBe('coverage:skipped not enabled');
    expect(formatTaskDetail(makeTask({ status: 'merged', reviewIteration: 2 }))).toBe('iter 2');
    expect(formatTaskDetail(makeTask({ status: 'merged' }))).toBe('-');
  });
});
