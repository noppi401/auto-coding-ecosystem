import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { trimPrDiff } from '../../utils/diff-trim.js';

function makeDiffBlock(filename: string, content: string): string {
  return `diff --git a/${filename} b/${filename}\nindex abc..def 100644\n--- a/${filename}\n+++ b/${filename}\n${content}`;
}

describe('trimPrDiff', () => {
  let origMaxChars: string | undefined;
  let origExclude: string | undefined;

  beforeEach(() => {
    origMaxChars = process.env.PR_DIFF_MAX_CHARS;
    origExclude = process.env.PR_DIFF_EXCLUDE;
    delete process.env.PR_DIFF_MAX_CHARS;
    delete process.env.PR_DIFF_EXCLUDE;
  });

  afterEach(() => {
    if (origMaxChars !== undefined) {
      process.env.PR_DIFF_MAX_CHARS = origMaxChars;
    } else {
      delete process.env.PR_DIFF_MAX_CHARS;
    }
    if (origExclude !== undefined) {
      process.env.PR_DIFF_EXCLUDE = origExclude;
    } else {
      delete process.env.PR_DIFF_EXCLUDE;
    }
  });

  it('空文字列をそのまま返す', () => {
    expect(trimPrDiff('')).toBe('');
  });

  it('上限以下のdiffはそのまま返す', () => {
    const diff = makeDiffBlock('src/foo.ts', '+const x = 1;\n');
    process.env.PR_DIFF_MAX_CHARS = '100000';
    const result = trimPrDiff(diff);
    expect(result).toContain('src/foo.ts');
    expect(result).not.toContain('トリミング');
  });

  it('package-lock.json を除外する（デフォルト除外設定）', () => {
    const lock = makeDiffBlock('package-lock.json', '+  "version": "1.0.0"\n');
    const code = makeDiffBlock('src/index.ts', '+const x = 1;\n');
    const diff = lock + '\n' + code;

    const result = trimPrDiff(diff);
    expect(result).not.toContain('diff --git a/package-lock.json');
    expect(result).toContain('diff --git a/src/index.ts');
    expect(result).toContain('package-lock.json');
    expect(result).toContain('除外');
  });

  it('yarn.lock を除外する（デフォルト除外設定）', () => {
    const lock = makeDiffBlock('yarn.lock', '+some lock content\n');
    const code = makeDiffBlock('src/app.ts', '+const y = 2;\n');
    const diff = lock + '\n' + code;

    const result = trimPrDiff(diff);
    expect(result).not.toContain('diff --git a/yarn.lock');
    expect(result).toContain('diff --git a/src/app.ts');
  });

  it('PR_DIFF_EXCLUDE で除外ファイルを上書きできる', () => {
    process.env.PR_DIFF_EXCLUDE = 'custom.lock';
    const lock = makeDiffBlock('custom.lock', '+lock content\n');
    const code = makeDiffBlock('src/main.ts', '+const z = 3;\n');
    const diff = lock + '\n' + code;

    const result = trimPrDiff(diff);
    expect(result).not.toContain('diff --git a/custom.lock');
    expect(result).toContain('diff --git a/src/main.ts');
  });

  it('上限を超える diff はトリミングして注釈を追加する', () => {
    const block1 = makeDiffBlock('src/a.ts', '+' + 'x'.repeat(100));
    const block2 = makeDiffBlock('src/b.ts', '+' + 'y'.repeat(100));
    const block3 = makeDiffBlock('src/c.ts', '+' + 'z'.repeat(100));
    const diff = [block1, block2, block3].join('\n');

    process.env.PR_DIFF_MAX_CHARS = '150';
    const result = trimPrDiff(diff);
    expect(result).toContain('トリミング');
    expect(result.length).toBeLessThanOrEqual(500);
  });

  it('PR_DIFF_MAX_CHARS=0 で文字数トリミングを無効化できる', () => {
    const block = makeDiffBlock('src/large.ts', '+' + 'a'.repeat(100000));
    process.env.PR_DIFF_MAX_CHARS = '0';
    const result = trimPrDiff(block);
    expect(result).not.toContain('トリミング');
  });

  it('複数ファイルブロックが正しく分割される', () => {
    const a = makeDiffBlock('src/a.ts', '+line a\n');
    const b = makeDiffBlock('src/b.ts', '+line b\n');
    const diff = a + '\n' + b;

    process.env.PR_DIFF_MAX_CHARS = '100000';
    const result = trimPrDiff(diff);
    expect(result).toContain('src/a.ts');
    expect(result).toContain('src/b.ts');
  });
});
