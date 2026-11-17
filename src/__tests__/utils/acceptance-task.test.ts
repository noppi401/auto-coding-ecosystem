import { describe, it, expect } from 'vitest';
import { buildAcceptanceTask } from '../../utils/acceptance-task.js';

const t = (targetFiles: string[], testFiles: string[]) =>
  ({ id: 'x', title: 'x', summary: 's', branchName: 'feat/x', targetFiles, testFiles, status: 'pending', reviewIteration: 0, createdAt: '', updatedAt: '' }) as any;

describe('buildAcceptanceTask', () => {
  it('最後に追加する受け入れタスクを作る（kind・連番のブランチ・専用テストファイル）', () => {
    const task = buildAcceptanceTask([t(['server.js'], ['test/server.test.js']), t(['public/index.html'], ['test/ui.test.js'])]);
    expect(task.kind).toBe('acceptance');
    expect(task.branchName).toBe('feat/task-003-acceptance');
    expect(task.testFiles).toEqual(['test/acceptance.test.js']);
    expect(task.status).toBe('pending');
  });

  it('FixAgent が実装側を直せるよう、全タスクの実装ファイルを重複なく targetFiles に持つ', () => {
    const task = buildAcceptanceTask([t(['server.js', 'package.json'], ['test/a.test.js']), t(['server.js', 'public/index.html'], ['test/b.test.js'])]);
    expect(task.targetFiles).toEqual(['server.js', 'package.json', 'public/index.html']);
  });

  it('テストのディレクトリと拡張子は既存のテストファイルに合わせる', () => {
    const task = buildAcceptanceTask([t(['src/app.ts'], ['src/__tests__/app.spec.ts'])]);
    expect(task.testFiles).toEqual(['src/__tests__/acceptance.spec.ts']);
  });

  it('既存のテストファイルが無ければ test/acceptance.test.js', () => {
    const task = buildAcceptanceTask([t(['server.js'], [])]);
    expect(task.testFiles).toEqual(['test/acceptance.test.js']);
  });
});
