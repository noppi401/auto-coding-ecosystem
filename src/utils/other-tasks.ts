import { Task } from '../state/types.js';

const OTHER_TASKS_MAX = 3000;

/**
 * 現在のタスク以外の計画（タイトルと生成予定ファイル）を、レビューに渡すための文字列にする。
 * 後続タスクが作るファイルへの参照を「欠落」と誤判定させないための情報。
 */
export function describeOtherTasks(tasks: Task[], current: Task): string {
  const lines = tasks
    .filter((t) => t.id !== current.id)
    .map((t) => {
      const files = [...t.targetFiles, ...(t.testFiles ?? [])];
      return `- ${t.title}: ${files.join(', ') || '(no files)'}`;
    });
  return lines.join('\n').substring(0, OTHER_TASKS_MAX);
}
