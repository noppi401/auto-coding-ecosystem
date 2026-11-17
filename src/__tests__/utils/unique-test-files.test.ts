import { describe, it, expect } from 'vitest';
import { assignUniqueTestFiles } from '../../utils/unique-test-files.js';

const task = (branchName: string, testFiles: string[]) => ({ branchName, testFiles });

describe('assignUniqueTestFiles', () => {
  it('複数タスクが同じテストファイルを指す場合、最初のタスクだけに残し、後のタスクには専用ファイルを割り当てる', () => {
    const tasks = [
      task('feat/task-002-http-server', ['test/api.test.js']),
      task('feat/task-005-get-endpoint', ['test/api.test.js']),
      task('feat/task-006-post-endpoint', ['test/api.test.js']),
    ];

    const { tasks: out, reassigned } = assignUniqueTestFiles(tasks);

    expect(out.map((t) => t.testFiles)).toEqual([
      ['test/api.test.js'],
      ['test/task-005-get-endpoint.test.js'],
      ['test/task-006-post-endpoint.test.js'],
    ]);
    expect(reassigned).toEqual([
      { branchName: 'feat/task-005-get-endpoint', from: 'test/api.test.js', to: 'test/task-005-get-endpoint.test.js' },
      { branchName: 'feat/task-006-post-endpoint', from: 'test/api.test.js', to: 'test/task-006-post-endpoint.test.js' },
    ]);
  });

  it('重複が無ければ何も変えない', () => {
    const tasks = [task('feat/a', ['test/a.test.js']), task('feat/b', ['test/b.test.js'])];
    const { tasks: out, reassigned } = assignUniqueTestFiles(tasks);
    expect(out.map((t) => t.testFiles)).toEqual([['test/a.test.js'], ['test/b.test.js']]);
    expect(reassigned).toEqual([]);
  });

  it('拡張子（.spec.ts など）とディレクトリを保つ。ルート直下のファイルも扱える', () => {
    const tasks = [
      task('feat/x', ['src/__tests__/app.spec.ts', 'server.test.js']),
      task('feat/task-002-y', ['src/__tests__/app.spec.ts', 'server.test.js']),
    ];
    const { tasks: out } = assignUniqueTestFiles(tasks);
    expect(out[1].testFiles).toEqual(['src/__tests__/task-002-y.spec.ts', 'task-002-y.test.js']);
  });

  it('同じタスク内で同じパスに割り当て直す場合は連番で区別する', () => {
    const tasks = [
      task('feat/a', ['test/x.test.js', 'test/y.test.js']),
      task('feat/task-002-b', ['test/x.test.js', 'test/y.test.js']),
    ];
    const { tasks: out } = assignUniqueTestFiles(tasks);
    expect(out[1].testFiles).toEqual(['test/task-002-b.test.js', 'test/task-002-b-2.test.js']);
  });

  it('元のタスク配列を書き換えない', () => {
    const tasks = [task('feat/a', ['t.test.js']), task('feat/b', ['t.test.js'])];
    assignUniqueTestFiles(tasks);
    expect(tasks[1].testFiles).toEqual(['t.test.js']);
  });
});
