import { randomUUID } from 'crypto';
import { Task } from '../state/types.js';
import { t } from './i18n.js';

const TEST_FILE = /^(.*\/)?[^/]+(\.(?:test|spec)\.[cm]?[jt]sx?)$/i;

/**
 * 分解したタスクの最後に追加する「受け入れ確認」タスクを作る。
 * このタスクでは、実装を見ない別エージェントが要件から受け入れテストを書き、起動確認ゲートも行う。
 * targetFiles には全タスクの実装ファイルを持たせ、失敗時に FixAgent が実装側を直せるようにする。
 */
export function buildAcceptanceTask(tasks: Task[]): Task {
  const targetFiles = [...new Set(tasks.flatMap((task) => task.targetFiles))];
  const firstTest = tasks.flatMap((task) => task.testFiles ?? []).map((p) => p.match(TEST_FILE)).find(Boolean);
  const testFile = firstTest ? `${firstTest[1] ?? ''}acceptance${firstTest[2]}` : 'test/acceptance.test.js';
  const number = String(tasks.length + 1).padStart(3, '0');
  const now = new Date().toISOString();

  return {
    id: randomUUID(),
    title: t('受け入れテストと起動確認', 'Acceptance tests and smoke check'),
    summary: t(
      '要件定義の受け入れ条件から、実装を見ずに HTTP レベルの受け入れテストを作成し、実際にアプリを起動して要件どおりに動くことを確認する。失敗した場合は実装側を修正する。',
      'Write HTTP-level acceptance tests from the acceptance criteria in the requirements, without looking at the implementation, and start the real app to confirm it works as required. If they fail, fix the implementation.'
    ),
    branchName: `feat/task-${number}-acceptance`,
    targetFiles,
    testFiles: [testFile],
    kind: 'acceptance',
    status: 'pending',
    reviewIteration: 0,
    createdAt: now,
    updatedAt: now,
  };
}
