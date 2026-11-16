import { describe, it, expect } from 'vitest';
import { findUnexecutedTestFiles } from '../../utils/unexecuted-tests.js';

const FILES = [
  'tests/api.test.js',
  'tests/integration.test.js',
  'tests/models/todo-manager.test.js',
];

describe('findUnexecutedTestFiles', () => {
  it('node --test に明示したファイル以外は未実行として返す（実機で見逃した構成）', () => {
    expect(findUnexecutedTestFiles('node --test tests/api.test.js', FILES)).toEqual([
      'tests/integration.test.js',
      'tests/models/todo-manager.test.js',
    ]);
  });

  it('全ファイルを列挙していれば空', () => {
    const script = `node --test ${FILES.join(' ')}`;
    expect(findUnexecutedTestFiles(script, FILES)).toEqual([]);
  });

  it('ファイル引数なしの node --test は自動探索なので空', () => {
    expect(findUnexecutedTestFiles('node --test', FILES)).toEqual([]);
    expect(findUnexecutedTestFiles('node --test --test-reporter=spec', FILES)).toEqual([]);
  });

  it('ディレクトリ指定は配下のファイルをカバーする', () => {
    expect(findUnexecutedTestFiles('node --test tests/', FILES)).toEqual([]);
    expect(findUnexecutedTestFiles('node --test tests/models', FILES)).toEqual([
      'tests/api.test.js',
      'tests/integration.test.js',
    ]);
  });

  it('glob 指定は一致するファイルだけをカバーする', () => {
    expect(findUnexecutedTestFiles('node --test "tests/**/*.test.js"', FILES)).toEqual([]);
    expect(findUnexecutedTestFiles('node --test tests/*.test.js', FILES)).toEqual([
      'tests/models/todo-manager.test.js',
    ]);
  });

  it('&& で連結した node --test の和集合をカバーとみなす', () => {
    const script = 'node --test tests/api.test.js && node --test tests/integration.test.js';
    expect(findUnexecutedTestFiles(script, FILES)).toEqual(['tests/models/todo-manager.test.js']);
  });

  it('vitest / jest 等の自動探索ランナーは空', () => {
    expect(findUnexecutedTestFiles('vitest run', FILES)).toEqual([]);
    expect(findUnexecutedTestFiles('jest --coverage', FILES)).toEqual([]);
  });

  it('解釈できない script（間接呼び出し等）は誤検出を避けて空', () => {
    expect(findUnexecutedTestFiles('npm run test:unit', FILES)).toEqual([]);
    expect(findUnexecutedTestFiles('node --test tests/api.test.js && npm run lint', FILES)).toEqual([]);
  });

  it('./ 付きや Windows 区切りのパスも同一視する', () => {
    expect(findUnexecutedTestFiles('node --test ./tests/api.test.js', ['tests\\api.test.js'])).toEqual([]);
  });
});
