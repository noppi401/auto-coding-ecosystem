import { describe, it, expect } from 'vitest';
import { decideRequirementsSplit, splitByHeadings, sliceByLineRanges } from '../../utils/requirements-split.js';

describe('decideRequirementsSplit', () => {
  it('既定閾値 8000 文字以上で分割、未満で単一', () => {
    expect(decideRequirementsSplit('a'.repeat(8000), {}).shouldSplit).toBe(true);
    expect(decideRequirementsSplit('a'.repeat(7999), {}).shouldSplit).toBe(false);
  });

  it('REQ_SPLIT_CHARS で閾値を変更でき、不正値は既定に戻る', () => {
    expect(decideRequirementsSplit('a'.repeat(100), { REQ_SPLIT_CHARS: '100' }).shouldSplit).toBe(true);
    expect(decideRequirementsSplit('a'.repeat(100), { REQ_SPLIT_CHARS: 'abc' }).shouldSplit).toBe(false);
  });

  it('REQ_SPLIT_MODE=always / never は文字数より優先する', () => {
    expect(decideRequirementsSplit('short', { REQ_SPLIT_MODE: 'always' }).shouldSplit).toBe(true);
    expect(decideRequirementsSplit('a'.repeat(20000), { REQ_SPLIT_MODE: 'never' }).shouldSplit).toBe(false);
  });
});

describe('splitByHeadings', () => {
  it('2回以上出る最も浅い見出しレベルで分け、前書きを preamble にする', () => {
    const md = [
      '# タスク管理アプリ',
      '共通: TypeScript で作る',
      '## 認証',
      'ログインできる',
      '### パスワード',
      '8文字以上',
      '## タスク',
      '追加・削除できる',
    ].join('\n');

    expect(splitByHeadings(md)).toEqual({
      preamble: '# タスク管理アプリ\n共通: TypeScript で作る',
      categories: [
        { title: '認証', content: '## 認証\nログインできる\n### パスワード\n8文字以上' },
        { title: 'タスク', content: '## タスク\n追加・削除できる' },
      ],
    });
  });

  it('コードブロック内の # は見出しとして扱わない', () => {
    const md = ['## A', '```bash', '# comment', '```', '## B', 'b'].join('\n');
    const result = splitByHeadings(md);
    expect(result?.categories.map((c) => c.title)).toEqual(['A', 'B']);
    expect(result?.categories[0].content).toContain('# comment');
  });

  it('同レベルの見出しが2つ未満なら null', () => {
    expect(splitByHeadings('# Title\nbody only')).toBeNull();
    expect(splitByHeadings('no headings at all')).toBeNull();
  });
});

describe('sliceByLineRanges', () => {
  const text = 'l1\nl2\nl3\nl4';

  it('全行を隙間なく覆う範囲なら原文どおり切り出す', () => {
    expect(sliceByLineRanges(text, [
      { title: 'A', startLine: 1, endLine: 2 },
      { title: 'B', startLine: 3, endLine: 4 },
    ])).toEqual([
      { title: 'A', content: 'l1\nl2' },
      { title: 'B', content: 'l3\nl4' },
    ]);
  });

  it.each([
    ['隙間あり', [{ title: 'A', startLine: 1, endLine: 1 }, { title: 'B', startLine: 3, endLine: 4 }]],
    ['重複あり', [{ title: 'A', startLine: 1, endLine: 3 }, { title: 'B', startLine: 3, endLine: 4 }]],
    ['末尾が欠ける', [{ title: 'A', startLine: 1, endLine: 2 }, { title: 'B', startLine: 3, endLine: 3 }]],
    ['1カテゴリのみ', [{ title: 'A', startLine: 1, endLine: 4 }]],
    ['数値でない', [{ title: 'A', startLine: NaN, endLine: 2 }, { title: 'B', startLine: 3, endLine: 4 }]],
  ])('%s の場合は null（内容欠落を防ぐ）', (_label, ranges) => {
    expect(sliceByLineRanges(text, ranges)).toBeNull();
  });
});
