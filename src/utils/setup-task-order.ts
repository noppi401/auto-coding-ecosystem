import { t } from './i18n.js';

const CONFIG_FILE =/^(?:package\.json|package-lock\.json|\.gitignore|\.npmrc|\.nvmrc|README(?:\.[a-z]+)?|tsconfig(?:\.[\w-]+)?\.json|\.editorconfig|\.eslintrc(?:\.\w+)?|\.prettierrc(?:\.\w+)?)$/i;

/**
 * package.json（test script）を作るタスクを先頭に置く。
 * 後ろにあると、それまでのタスクは npm test を実行できないまま進む（run 30 では 9 タスクがそうだった）。
 * 順序を崩して依存関係を壊さないよう、自動で移すのは「設定ファイルだけを作るタスク」に限り、
 * 実装ファイルも含む場合は移さずに warning を返す。
 */
export function moveSetupTaskFirst<T extends { title: string; targetFiles: string[] }>(
  tasks: T[]
): { tasks: T[]; moved?: string; warning?: string } {
  const index = tasks.findIndex((task) => task.targetFiles.some((f) => f.replace(/^\.\//, '') === 'package.json'));
  if (index <= 0) return { tasks };

  const task = tasks[index];
  const onlyConfig = task.targetFiles.every((f) => CONFIG_FILE.test(f.replace(/^\.\//, '')));
  if (!onlyConfig) {
    return {
      tasks,
      warning: t(
        `package.json を作るタスク「${task.title}」が ${index + 1} 番目にあり、実装ファイルも含むため先頭に移せません。それまでのタスクは node --test で直接テストします。`,
        `The task that creates package.json ("${task.title}") is at position ${index + 1} and also includes implementation files, so it cannot be moved first. Earlier tasks are tested directly with node --test.`
      ),
    };
  }
  return { tasks: [task, ...tasks.slice(0, index), ...tasks.slice(index + 1)], moved: task.title };
}
