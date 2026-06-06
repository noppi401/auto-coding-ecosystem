import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  buildTaskKeywords,
  extractRelevantDoc,
  isDocRelevanceEnabled,
} from '../../utils/doc-relevance.js';
import type { Task } from '../../state/types.js';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'authentication middleware',
    summary: 'implement JWT authentication for API routes',
    branchName: 'feat/auth',
    targetFiles: ['src/middleware/auth.ts'],
    status: 'pending',
    reviewIteration: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('isDocRelevanceEnabled', () => {
  let orig: string | undefined;

  beforeEach(() => {
    orig = process.env.IMPL_DOC_RELEVANCE;
  });
  afterEach(() => {
    if (orig !== undefined) {
      process.env.IMPL_DOC_RELEVANCE = orig;
    } else {
      delete process.env.IMPL_DOC_RELEVANCE;
    }
  });

  it('IMPL_DOC_RELEVANCE 未設定では false を返す', () => {
    delete process.env.IMPL_DOC_RELEVANCE;
    expect(isDocRelevanceEnabled()).toBe(false);
  });

  it('IMPL_DOC_RELEVANCE=true では true を返す', () => {
    process.env.IMPL_DOC_RELEVANCE = 'true';
    expect(isDocRelevanceEnabled()).toBe(true);
  });

  it('IMPL_DOC_RELEVANCE=false では false を返す', () => {
    process.env.IMPL_DOC_RELEVANCE = 'false';
    expect(isDocRelevanceEnabled()).toBe(false);
  });
});

describe('buildTaskKeywords', () => {
  it('タイトルと概要からキーワードを抽出する', () => {
    const task = makeTask({ title: 'cache layer', summary: 'add redis caching' });
    const keywords = buildTaskKeywords(task);
    expect(keywords).toContain('cache');
    expect(keywords).toContain('layer');
    expect(keywords).toContain('redis');
    expect(keywords).toContain('caching');
  });

  it('ストップワードは除外される', () => {
    const task = makeTask({ title: 'this and that for the', summary: 'task is done' });
    const keywords = buildTaskKeywords(task);
    expect(keywords).not.toContain('this');
    expect(keywords).not.toContain('and');
    expect(keywords).not.toContain('the');
    expect(keywords).not.toContain('for');
    expect(keywords).not.toContain('task');
  });

  it('targetFiles からファイル名・語幹を抽出する', () => {
    const task = makeTask({
      title: 'update routes',
      summary: 'refactor',
      targetFiles: ['src/api/userController.ts'],
    });
    const keywords = buildTaskKeywords(task);
    expect(keywords).toContain('src');
    expect(keywords).toContain('api');
  });

  it('targetFiles が空のときもエラーにならない', () => {
    const task = makeTask({ targetFiles: [] });
    expect(() => buildTaskKeywords(task)).not.toThrow();
  });

  it('重複キーワードが除去される', () => {
    const task = makeTask({
      title: 'auth authentication',
      summary: 'auth implementation',
    });
    const keywords = buildTaskKeywords(task);
    const counts = keywords.filter((k) => k === 'auth').length;
    expect(counts).toBe(1);
  });
});

describe('extractRelevantDoc', () => {
  const task = makeTask({
    title: 'authentication',
    summary: 'JWT auth implementation',
    targetFiles: ['src/auth.ts'],
  });

  it('上限以下のドキュメントはそのまま返す', () => {
    const doc = '# Authentication\n\nJWT based auth.\n';
    const result = extractRelevantDoc(doc, task, 10000);
    expect(result).toBe(doc);
  });

  it('空文字列はそのまま返す', () => {
    expect(extractRelevantDoc('', task, 100)).toBe('');
  });

  it('関連スコアの高いセクションを優先して返す', () => {
    const doc = [
      '# Authentication\n\nJWT authentication middleware for API.\n',
      '# Database\n\nPostgreSQL setup and migration guide.\n',
      '# Logging\n\nApplication logging configuration.\n',
    ].join('\n');

    const result = extractRelevantDoc(doc, task, 100);
    expect(result).toContain('Authentication');
    expect(result).not.toContain('Database');
  });

  it('関連セクションがない場合は先頭 maxChars 文字にフォールバックする', () => {
    const irrelevantTask = makeTask({
      title: 'xyz unrelated topic',
      summary: 'something totally different',
      targetFiles: [],
    });
    const doc = 'A'.repeat(500);
    const result = extractRelevantDoc(doc, irrelevantTask, 100);
    expect(result).toBe('A'.repeat(100));
  });

  it('複数の関連セクションを元の文書順で返す', () => {
    const doc = [
      '# Overview\n\nProject overview.\n',
      '# Authentication\n\nJWT auth setup.\n',
      '# Logging\n\nLog config.\n',
      '# Auth Middleware\n\nAuth middleware details.\n',
    ].join('\n');

    const result = extractRelevantDoc(doc, task, 300);
    const authIdx = result.indexOf('Authentication');
    const middlewareIdx = result.indexOf('Auth Middleware');
    if (authIdx !== -1 && middlewareIdx !== -1) {
      expect(authIdx).toBeLessThan(middlewareIdx);
    }
  });

  it('省略されたセクションがある場合は注釈を付与する', () => {
    // 関連キーワード(authentication, jwt, auth)を含む5セクション × 各約100文字
    // maxChars=200 では全てを収められないので省略注釈が付く
    const sections = Array.from(
      { length: 5 },
      (_, i) => `# Auth Section ${i}\n\nJWT authentication details ${'x'.repeat(50)}\n`
    );
    const doc = sections.join('\n');
    const result = extractRelevantDoc(doc, task, 200);
    expect(result).toContain('省略');
  });
});
