import { localDependencies } from './local-deps.js';

const NON_SOURCE = /(?:^|\/)(?:tests?|__tests__|spec)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)[^/]*\.config\.[cm]?[jt]s$/i;

/**
 * 起動ファイルから require / import をたどり、どこからも読み込まれないソースファイルを返す。
 * 「作ったのにつながっていない」モジュールを見つけるため
 * （run 34: 本物の画面 html-template.js を誰も読み込まず、GET / は仮置きの HTML のままだった）。
 * テスト・テスト用ヘルパー・*.config.* は対象外。起動ファイルが無ければ判定しない。
 */
export function findUnreachableModules(entry: string, files: Record<string, string>): string[] {
  const paths = Object.keys(files);
  if (!(entry in files)) return [];

  const reached = new Set<string>([entry]);
  const queue = [entry];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const dep of localDependencies([{ path: current, content: files[current] }], paths)) {
      if (!reached.has(dep)) {
        reached.add(dep);
        queue.push(dep);
      }
    }
  }
  return paths.filter((p) => /\.[cm]?[jt]sx?$/i.test(p) && !NON_SOURCE.test(p) && !reached.has(p));
}
