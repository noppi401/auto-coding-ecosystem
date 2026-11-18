/**
 * package.json の test script が実行しないテストファイルを返す。
 *
 * ゲートは `npm test` の終了コードだけを見るため、生成された script が
 * `node --test tests/api.test.js` のように一部のファイルしか実行しないと、
 * 他のテストが壊れていても「通過」になる。その穴を決定論的に検知する。
 *
 * 判定できるのは `node --test` 系（&& 連結を含む）のみ。vitest/jest 等の自動探索ランナーや、
 * 解釈できない script は、誤ブロックを避けるため空配列（=検知対象外）を返す。
 */
const normalize = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');

function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else { re += '.*'; }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

type Coverage = { all: true } | { all: false; covers: (file: string) => boolean };

function coverageOfNodeTest(segment: string): Coverage {
  const tokens = segment.trim().split(/\s+/);
  const idx = tokens.indexOf('--test');
  const args = tokens.slice(idx + 1).filter((t) => !t.startsWith('-')).map((t) => t.replace(/^["']|["']$/g, ''));
  if (args.length === 0) return { all: true };
  // コンパイル済みのテスト（dist/tests/x.test.js）は元ファイル（tests/x.test.ts）として比べる。
  // 比較は「ビルド先ディレクトリを除き、拡張子を外した」パス同士で行う（f は呼び出し側で同じ変換済み）。
  const matchers = args.map((raw) => {
    const normalized = normalize(raw).replace(BUILD_DIR, '');
    const hasExt = /\.[A-Za-z0-9]+$/.test(normalized);
    const arg = stripExt(normalized);
    if (/[*?]/.test(arg)) {
      const re = globToRegExp(arg);
      return (f: string) => re.test(f);
    }
    // 拡張子のないトークンはディレクトリとして扱う
    if (!hasExt) return (f: string) => f === arg || f.startsWith(`${arg}/`);
    return (f: string) => f === arg;
  });
  return { all: false, covers: (f) => matchers.some((m) => m(f)) };
}

const BUILD_DIR = /^(?:dist|build|out)\//;
const stripExt = (p: string) => p.replace(/\.[cm]?[jt]sx?$/i, '');
// テストの前に置かれるビルド工程。テストの実行範囲には影響しないので判定の対象外として読み飛ばす
const BUILD_STEP = /^(?:npm run (?:build|compile)|(?:npx\s+)?tsc)(?:\s|$)/;

export function findUnexecutedTestFiles(testScript: string, testFiles: string[]): string[] {
  const segments = testScript.split(/&&|;/).map((s) => s.trim()).filter(Boolean);
  const covers: Array<(f: string) => boolean> = [];
  for (const seg of segments) {
    if (BUILD_STEP.test(seg)) continue;
    if (!/(^|\s)node\s+(?:\S+\s+)*--test(\s|$)/.test(seg)) return []; // 解釈不能 → 対象外
    const cov = coverageOfNodeTest(seg);
    if (cov.all) return [];
    covers.push(cov.covers);
  }
  if (covers.length === 0) return [];
  return testFiles.filter((f) => {
    const n = stripExt(normalize(f));
    return !covers.some((c) => c(n));
  });
}
