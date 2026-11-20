import { posix } from 'path';

const JS_FILE = /\.[cm]?[jt]sx?$/i;
// require('x') / import ... from 'x' / export ... from 'x' / import('x') / import 'x'
const SPECIFIER = /(?:require\s*\(\s*|import\s*\(\s*|\bfrom\s+|^\s*import\s+)(['"])(\.{1,2}\/[^'"]+)\1/gm;
const CANDIDATE_SUFFIXES = ['', '.js', '.mjs', '.cjs', '.ts', '/index.js', '/index.mjs', '/index.ts'];

/**
 * 与えたファイルが require / import で直接読み込む、リポジトリ内のファイルを返す（1 段のみ）。
 * レビューと修正に依存先の中身も見せ、タスク間のインターフェースの食い違い
 * （run 32: server.js は renderHomePage(req, res) が応答を書く前提、ui/html.js は文字列を返すだけ）を
 * 見つけられるようにする。入力に含まれるファイル自身・パッケージ・存在しないパスは除く。
 */
export function localDependencies(
  files: Array<{ path: string; content: string }>,
  trackedFiles: string[]
): string[] {
  const tracked = new Set(trackedFiles.map((p) => p.replace(/\\/g, '/')));
  const given = new Set(files.map((f) => f.path.replace(/\\/g, '/')));
  const deps: string[] = [];

  for (const file of files) {
    const from = file.path.replace(/\\/g, '/');
    if (!JS_FILE.test(from)) continue;
    for (const match of file.content.matchAll(SPECIFIER)) {
      const base = posix.normalize(posix.join(posix.dirname(from), match[2]));
      const resolved = CANDIDATE_SUFFIXES.map((s) => `${base}${s}`).find((p) => tracked.has(p));
      if (resolved && !given.has(resolved) && !deps.includes(resolved)) deps.push(resolved);
    }
  }
  return deps;
}
