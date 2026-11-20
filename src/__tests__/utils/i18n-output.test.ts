import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ACE_LANG=en のとき、利用者に見える出力（PR コメント・状態表示・タスク名）が英語になることを確かめる。
// locale はモジュール読み込み時に決まるため、環境変数を設定してからモジュールを読み込み直す。
const JAPANESE = /[぀-ヿ一-鿿]/;

const DELETION_DIFF = [
  'diff --git a/test/a.test.js b/test/a.test.js',
  'deleted file mode 100644',
  '--- a/test/a.test.js',
  '+++ /dev/null',
  "-it('works', () => { expect(1).toBe(1); });",
  'diff --git a/test/b.test.js b/test/b.test.js',
  '--- a/test/b.test.js',
  '+++ b/test/b.test.js',
  "+it.skip('later', () => {});",
].join('\n');

const VALIDATION = {
  score: 55,
  grade: 'C',
  summary: 'summary text',
  issues: [],
  recommendations: [],
  categories: { clarity: { score: 10, comment: 'comment' } },
};

async function loadOutputs() {
  const { buildAcceptanceTask } = await import('../../utils/acceptance-task.js');
  const { formatTestFailureComment } = await import('../../utils/parse-test-output.js');
  const { formatCoverageComment } = await import('../../utils/parse-coverage.js');
  const { selectInstallCommand } = await import('../../utils/package-manager.js');
  const { moveSetupTaskFirst } = await import('../../utils/setup-task-order.js');
  const { Orchestrator } = await import('../../orchestrator.js');
  const orchestrator = new Orchestrator('.ecosystem/__i18n-test-state.json') as any;

  const acceptance = buildAcceptanceTask([]);
  return {
    acceptanceTitle: acceptance.title,
    acceptanceSummary: acceptance.summary,
    testFailure: formatTestFailureComment(
      { failedFiles: ['test/a.test.js'], failedTests: [{ name: 'adds a todo', error: 'AssertionError' }], totalFailed: 1 },
      ''
    ),
    coverage: formatCoverageComment({ lines: 50, branches: 40, functions: 60, statements: 50 }, 70, 60),
    installReason: selectInstallCommand(null, {}).reason,
    setupWarning: moveSetupTaskFirst([
      { title: 'store', targetFiles: ['store.js'] },
      { title: 'setup', targetFiles: ['package.json', 'server.js'] },
    ]).warning ?? '',
    regressionComments: (orchestrator._detectTestDeletion(DELETION_DIFF) as Array<{ body: string }>).map((c) => c.body),
    validationReport: orchestrator._buildValidationMarkdown('Report', VALIDATION) as string,
  };
}

describe('ACE_LANG による出力言語の切り替え', () => {
  let origAceLang: string | undefined;
  let origLang: string | undefined;

  beforeEach(() => {
    origAceLang = process.env.ACE_LANG;
    origLang = process.env.LANG;
    vi.resetModules();
  });

  afterEach(() => {
    if (origAceLang !== undefined) process.env.ACE_LANG = origAceLang;
    else delete process.env.ACE_LANG;
    if (origLang !== undefined) process.env.LANG = origLang;
    else delete process.env.LANG;
    vi.resetModules();
  });

  it('ACE_LANG=en のとき、タスク名・ゲートのコメント・検証レポートに日本語が残らない', async () => {
    process.env.ACE_LANG = 'en';
    const out = await loadOutputs();

    expect(out.acceptanceTitle).toBe('Acceptance tests and smoke check');
    expect(out.testFailure).toContain('1 test(s) failed');
    expect(out.coverage).toContain('Coverage: below threshold');
    expect(out.installReason).toContain('using npm install');
    expect(out.setupWarning).toContain('cannot be moved first');
    // 削除されたファイルの it( / expect( も純減として数えるため、4 件になる
    const regressions = out.regressionComments.join('\n');
    expect(regressions).toContain('Deleting tests is not allowed');
    expect(regressions).toContain('Disabling tests is not allowed');
    expect(regressions).toContain('Removing test cases is not allowed');
    expect(regressions).toContain('Removing assertions is not allowed');
    expect(out.validationReport).toContain('Overall score: 55 / 100');

    for (const [name, value] of Object.entries(out)) {
      const text = Array.isArray(value) ? value.join('\n') : value;
      expect(JAPANESE.test(text ?? ''), `${name} contains Japanese: ${text}`).toBe(false);
    }
  });

  it('ACE_LANG も LANG も未設定のときは、従来どおり日本語で出力する', async () => {
    delete process.env.ACE_LANG;
    delete process.env.LANG;
    const out = await loadOutputs();

    expect(out.acceptanceTitle).toBe('受け入れテストと起動確認');
    expect(out.testFailure).toContain('1 件のテストが失敗しました');
    expect(out.regressionComments[0]).toContain('テスト削除禁止');
    expect(out.validationReport).toContain('総合スコア: 55点 / 100点');
  });
});
