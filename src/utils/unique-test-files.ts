/**
 * 複数タスクが同じテストファイルを指す分解を、タスクごとの専用テストファイルに直す。
 *
 * 1 本のテストファイルに全タスクが追記していくと、ファイルが育つほど生成が遅く失敗しやすくなり、
 * 既存テストの上書き・hunk 編集の崩れ・削除検出との衝突が起きる。最初に指したタスクだけに残し、
 * 後のタスクにはブランチ名から作った専用パス（同じディレクトリ・同じテスト拡張子）を割り当てる。
 */
const TEST_EXT = /(\.(?:test|spec)\.[cm]?[jt]sx?)$/i;

export function assignUniqueTestFiles<T extends { branchName: string; testFiles?: string[] }>(
  tasks: T[]
): { tasks: T[]; reassigned: Array<{ branchName: string; from: string; to: string }> } {
  const owned = new Set<string>();
  const reassigned: Array<{ branchName: string; from: string; to: string }> = [];

  const out = tasks.map((task) => {
    const slug = task.branchName.replace(/^.*\//, '').replace(/[^A-Za-z0-9._-]/g, '-') || 'task';
    const files = (task.testFiles ?? []).map((path) => {
      if (!owned.has(path)) {
        owned.add(path);
        return path;
      }
      const slash = path.lastIndexOf('/');
      const dir = slash >= 0 ? path.slice(0, slash + 1) : '';
      const ext = path.match(TEST_EXT)?.[1] ?? '.test.js';
      let candidate = `${dir}${slug}${ext}`;
      for (let n = 2; owned.has(candidate); n++) candidate = `${dir}${slug}-${n}${ext}`;
      owned.add(candidate);
      reassigned.push({ branchName: task.branchName, from: path, to: candidate });
      return candidate;
    });
    return { ...task, testFiles: files };
  });

  return { tasks: out, reassigned };
}
