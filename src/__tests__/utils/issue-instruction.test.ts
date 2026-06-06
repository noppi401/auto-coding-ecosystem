import { describe, it, expect } from 'vitest';
import {
  buildIssueInstruction,
  buildIssuesInstruction,
} from '../../utils/issue-instruction.js';
import type { SourceIssue } from '../../state/types.js';

function makeIssue(overrides: Partial<SourceIssue> = {}): SourceIssue {
  return {
    number: 1,
    title: 'Fix bug',
    body: 'This is the issue body.',
    url: 'https://github.com/owner/repo/issues/1',
    labels: [],
    ...overrides,
  };
}

describe('buildIssueInstruction', () => {
  it('Issue番号・タイトル・URL・本文を含む文字列を生成する', () => {
    const issue = makeIssue();
    const result = buildIssueInstruction(issue);

    expect(result).toContain('GitHub Issue #1: Fix bug');
    expect(result).toContain('https://github.com/owner/repo/issues/1');
    expect(result).toContain('This is the issue body.');
  });

  it('ラベルがある場合はカンマ区切りで表示する', () => {
    const issue = makeIssue({ labels: ['bug', 'high-priority'] });
    const result = buildIssueInstruction(issue);
    expect(result).toContain('bug, high-priority');
  });

  it('ラベルが空のときは "none" と表示する', () => {
    const issue = makeIssue({ labels: [] });
    const result = buildIssueInstruction(issue);
    expect(result).toContain('Labels: none');
  });

  it('本文が空のときは "(no body)" と表示する', () => {
    const issue = makeIssue({ body: '' });
    const result = buildIssueInstruction(issue);
    expect(result).toContain('(no body)');
  });

  it('本文の前後の空白はトリムされる', () => {
    const issue = makeIssue({ body: '  body text  ' });
    const result = buildIssueInstruction(issue);
    expect(result).toContain('body text');
    expect(result).not.toContain('  body text  ');
  });
});

describe('buildIssuesInstruction', () => {
  it('Issue が1件のときは buildIssueInstruction と同じ出力になる', () => {
    const issue = makeIssue();
    const single = buildIssueInstruction(issue);
    const multi = buildIssuesInstruction([issue]);
    expect(multi).toBe(single);
  });

  it('複数 Issue のとき一覧ヘッダーを含む', () => {
    const issues = [
      makeIssue({ number: 1, title: 'First issue' }),
      makeIssue({ number: 2, title: 'Second issue', url: 'https://github.com/owner/repo/issues/2' }),
    ];
    const result = buildIssuesInstruction(issues);
    expect(result).toContain('GitHub Issues:');
    expect(result).toContain('#1: First issue');
    expect(result).toContain('#2: Second issue');
  });

  it('複数 Issue のとき各 Issue の詳細が含まれる', () => {
    const issues = [
      makeIssue({ number: 1, title: 'First', body: 'Body 1' }),
      makeIssue({ number: 2, title: 'Second', body: 'Body 2', url: 'https://github.com/owner/repo/issues/2' }),
    ];
    const result = buildIssuesInstruction(issues);
    expect(result).toContain('Body 1');
    expect(result).toContain('Body 2');
  });

  it('複数 Issue のとき区切り線が入る', () => {
    const issues = [
      makeIssue({ number: 1, title: 'A' }),
      makeIssue({ number: 2, title: 'B', url: 'https://github.com/owner/repo/issues/2' }),
    ];
    const result = buildIssuesInstruction(issues);
    expect(result).toContain('---');
  });
});
