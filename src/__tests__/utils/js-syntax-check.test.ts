import { describe, it, expect } from 'vitest';
import { checkJsSyntax } from '../../utils/js-syntax-check.js';

describe('checkJsSyntax', () => {
  it('変数の二重宣言のような構文エラーを、ファイル名と行の情報つきで返す（run 31 で FixAgent が入れた誤り）', async () => {
    const errors = await checkJsSyntax([
      { path: 'test/bootstrap.test.js', content: "const { status } = a();\nconst { status } = b();\n" },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toBe('test/bootstrap.test.js');
    expect(errors[0].message).toMatch(/status.*already been declared/);
  });

  it('括弧の閉じ忘れも検出する', async () => {
    const errors = await checkJsSyntax([{ path: 'a.js', content: 'function f() {\n  return 1;\n' }]);
    expect(errors.map((e) => e.path)).toEqual(['a.js']);
  });

  it('正しい CommonJS・ES モジュール・.mjs/.cjs は通す', async () => {
    const errors = await checkJsSyntax([
      { path: 'cjs.js', content: "const x = require('node:path');\nmodule.exports = { x };\n" },
      { path: 'esm.js', content: "import path from 'node:path';\nexport const y = path.sep;\n" },
      { path: 'm.mjs', content: 'export default 1;\n' },
      { path: 'c.cjs', content: 'module.exports = 1;\n' },
    ]);
    expect(errors).toEqual([]);
  });

  it('JS 以外のファイルは対象外', async () => {
    expect(await checkJsSyntax([{ path: 'README.md', content: 'const const' }, { path: 'a.ts', content: 'let x: = ' }])).toEqual([]);
  });
});
