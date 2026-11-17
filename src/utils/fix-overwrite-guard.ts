const normalize = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '');

/**
 * FixAgent が出力したファイルのうち、「見せていない既存ファイル」への書き込みを除外する。
 *
 * FixAgent は差分に含まれるファイルの内容しか受け取らない。見ていない既存ファイルを
 * 「新規ファイル」として全文出力すると、既存の内容（テスト等）を丸ごと消してしまう。
 * 存在しない（=真の新規）ファイルと、内容を渡したファイルの更新だけを通す。
 */
export async function guardUnshownOverwrites<T extends { path: string }>(
  outputFiles: T[],
  shownPaths: string[],
  existsInRepo: (path: string) => Promise<boolean>
): Promise<{ kept: T[]; blocked: string[] }> {
  const shown = new Set(shownPaths.map(normalize));
  const kept: T[] = [];
  const blocked: string[] = [];
  for (const f of outputFiles) {
    const path = normalize(f.path);
    if (shown.has(path) || !(await existsInRepo(path))) {
      kept.push(f);
    } else {
      blocked.push(path);
    }
  }
  return { kept, blocked };
}
