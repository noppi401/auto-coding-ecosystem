import type { Task } from '../state/types.js';

export function truncate(v: string, n: number): string {
  return v.length <= n ? v : v.slice(0, n - 3) + '...';
}

export function cleanOneLine(v: string): string {
  return v.replace(/\s+/g, ' ').trim();
}

export function formatLatestCheckDetail(task: Task): string | null {
  const visible = (task.lastChecks ?? []).filter((check) => check.status !== 'passed');
  const latest = visible.length > 0 ? visible[visible.length - 1] : null;
  if (!latest) return null;
  return truncate(cleanOneLine(`${latest.name}:${latest.status} ${latest.summary}`), 60);
}

/** 状態一覧の DETAIL 欄。スキップしたタスクは、前の失敗のチェック結果ではなくスキップの理由を出す。 */
export function formatTaskDetail(task: Task): string {
  if (task.status === 'skipped' && task.errorMessage) {
    return truncate(cleanOneLine(task.errorMessage), 60);
  }
  return formatLatestCheckDetail(task)
    ?? (task.status === 'failed' && task.errorMessage
      ? truncate(cleanOneLine(task.errorMessage), 60)
      : task.reviewIteration > 0 ? `iter ${task.reviewIteration}` : '-');
}
