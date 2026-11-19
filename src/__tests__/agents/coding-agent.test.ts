import { describe, it, expect, vi } from 'vitest';
import { CodingAgent } from '../../agents/coding-agent.js';
import { LlmUsageLimitError } from '../../utils/llm-errors.js';

vi.mock('../../utils/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), section: vi.fn() },
}));

const wrap = (files: unknown[]) =>
  JSON.stringify({ files, commitMessage: 'feat: x', prTitle: 't', prBody: 'b' });

const makeTask = (over: Record<string, unknown> = {}) =>
  ({
    id: 't2',
    title: 'HTTP Server Foundation',
    summary: 'Implement server.js routing',
    targetFiles: ['server.js'],
    testFiles: ['server.test.js'],
    ...over,
  }) as any;

const okResponse = (files: unknown[]) =>
  JSON.stringify({ files, commitMessage: 'feat', prTitle: 't', prBody: 'b' });

describe('CodingAgent.generateCode: 既存ファイルと他タスクの扱い', () => {
  it('既存の対象ファイルは、6000 文字を超えても切り詰めずに全文を渡す（全文出力のため、欠けると既存コードが消える）', async () => {
    const agent = new CodingAgent();
    const big = Array.from({ length: 800 }, (_, i) => `const line${i} = ${i};`).join('\n'); // 約 14000 文字
    const invoke = vi.spyOn(agent as any, 'invoke').mockResolvedValue(
      okResponse([{ path: 'server.js', lines: ['x'] }, { path: 'server.test.js', lines: ['y'] }])
    );

    await agent.generateCode(makeTask(), 'req', 'design', { 'server.js': big });

    const prompt = invoke.mock.calls[0][0] as string;
    expect(prompt).toContain('const line799 = 799;');
  });

  it('既存ファイルがある場合、既存のコードとテストを保持して追加するよう指示する', async () => {
    const agent = new CodingAgent();
    const invoke = vi.spyOn(agent as any, 'invoke').mockResolvedValue(
      okResponse([{ path: 'server.js', lines: ['x'] }, { path: 'server.test.js', lines: ['y'] }])
    );

    await agent.generateCode(makeTask(), 'req', 'design', { 'server.js': 'const a = 1;' });

    const prompt = invoke.mock.calls[0][0] as string;
    expect(prompt).toContain('const a = 1;');
    expect(prompt).toMatch(/keep ALL existing code and tests/i);
  });

  it('他タスクの計画を渡し、このタスクの範囲だけを実装するよう指示する', async () => {
    const agent = new CodingAgent();
    const invoke = vi.spyOn(agent as any, 'invoke').mockResolvedValue(
      okResponse([{ path: 'server.js', lines: ['x'] }, { path: 'server.test.js', lines: ['y'] }])
    );

    await agent.generateCode(makeTask(), 'req', 'design', {}, '- Implement GET /api/todos: server.js');

    const prompt = invoke.mock.calls[0][0] as string;
    expect(prompt).toContain('OTHER PLANNED TASKS');
    expect(prompt).toContain('Implement GET /api/todos');
    expect(prompt).toMatch(/ONLY this task/);
  });

  it('プロジェクトの文脈（設定ファイルとファイル一覧）を参照用として、本体の生成とテスト追加の生成の両方に渡す', async () => {
    // run 27: 新規テストだけのタスクで設定もファイル一覧も見えず、CommonJS のプロジェクトに ESM で書いた
    const agent = new CodingAgent();
    const invoke = vi
      .spyOn(agent as any, 'invoke')
      .mockResolvedValueOnce(okResponse([{ path: 'server.js', lines: ['impl'] }]))
      .mockResolvedValueOnce(okResponse([{ path: 'server.test.js', lines: ['t'] }]));
    const context = 'package.json:\n{"name":"app","scripts":{"test":"node --test"}}\n\nFILES:\n- test/test-utils.js';

    await agent.generateCode(makeTask(), 'req', 'design', {}, '', context);

    for (const call of invoke.mock.calls) {
      const prompt = call[0] as string;
      expect(prompt).toContain('PROJECT CONTEXT');
      expect(prompt).toContain('- test/test-utils.js');
      expect(prompt).toMatch(/module system/i);
    }
  });

  it('テスト追加の再生成でも、既存のテストファイルの内容を渡す（書き直しで既存テストを消さない）', async () => {
    const agent = new CodingAgent();
    const invoke = vi
      .spyOn(agent as any, 'invoke')
      .mockResolvedValueOnce(okResponse([{ path: 'server.js', lines: ['impl'] }])) // テストなし
      .mockResolvedValueOnce(okResponse([{ path: 'server.test.js', lines: ['t'] }]));

    await agent.generateCode(makeTask(), 'req', 'design', {
      'server.js': 'old impl',
      'server.test.js': "it('existing test A', () => {});",
    });

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[1][0] as string).toContain("it('existing test A'");
  });
});

describe('CodingAgent: 既存ファイルは hunk（変更範囲）で返させる', () => {
  const existing = { 'server.js': ['const a = 1;', 'const b = 2;', 'export { a, b };'].join('\n') };

  it('既存ファイルは行番号付きで見せ、hunk で返すよう指示する（全文出力は出力上限を超える）', async () => {
    const agent = new CodingAgent();
    const invoke = vi.spyOn(agent as any, 'invoke').mockResolvedValue(
      okResponse([
        { path: 'server.js', hunks: [{ startLine: 2, endLine: 2, newLines: ['const b = 3;'] }] },
        { path: 'server.test.js', lines: ['t'] },
      ])
    );

    const out = await agent.generateCode(makeTask(), 'req', 'design', existing);

    const prompt = invoke.mock.calls[0][0] as string;
    expect(prompt).toContain('2| const b = 2;');
    expect(prompt).toMatch(/hunks/);
    expect(out.files.find((f) => f.path === 'server.js')?.content).toBe('const a = 1;\nconst b = 3;\nexport { a, b };');
  });

  it('挿入（endLine = startLine - 1）で既存行を残したまま追加できる', () => {
    const agent = new CodingAgent();
    const out = agent.parseCodeFromResponse(
      wrap([{ path: 'server.js', hunks: [{ startLine: 3, endLine: 2, newLines: ['const c = 3;'] }] }]),
      existing
    );
    expect(out.files[0].content).toBe('const a = 1;\nconst b = 2;\nconst c = 3;\nexport { a, b };');
  });

  it('見せていないファイルへの hunk は、握りつぶさず例外にする', () => {
    const agent = new CodingAgent();
    expect(() =>
      agent.parseCodeFromResponse(wrap([{ path: 'other.js', hunks: [{ startLine: 1, endLine: 1, newLines: ['x'] }] }]), existing)
    ).toThrow(/other\.js/);
  });

  it('範囲外の行番号を指す hunk は例外にする（黙って末尾に足したりしない）', () => {
    const agent = new CodingAgent();
    expect(() =>
      agent.parseCodeFromResponse(wrap([{ path: 'server.js', hunks: [{ startLine: 10, endLine: 12, newLines: ['x'] }] }]), existing)
    ).toThrow(/out of range/);
  });

  it('重なり合う hunk は例外にする', () => {
    const agent = new CodingAgent();
    expect(() =>
      agent.parseCodeFromResponse(
        wrap([{ path: 'server.js', hunks: [
          { startLine: 1, endLine: 2, newLines: ['x'] },
          { startLine: 2, endLine: 3, newLines: ['y'] },
        ] }]),
        existing
      )
    ).toThrow(/overlap/);
  });
});

describe('CodingAgent.parseCodeFromResponse: ファイル本文の形式', () => {
  const agent = new CodingAgent();

  it('lines 配列を改行で連結し、末尾に改行を 1 つ付ける', () => {
    const out = agent.parseCodeFromResponse(wrap([{ path: 'src/a.js', lines: ['const a = 1;', 'export { a };'] }]));
    expect(out.files[0].content).toBe('const a = 1;\nexport { a };\n');
  });

  it('末尾が空行の lines でも改行が二重にならない', () => {
    const out = agent.parseCodeFromResponse(wrap([{ path: 'a.txt', lines: ['x', ''] }]));
    expect(out.files[0].content).toBe('x\n');
  });

  it('引用符・バックスラッシュ・日本語・タブを含む行が往復で保たれる（JSON エスケープ越し）', () => {
    const lines = ['const s = "a\\nb";', "\tconsole.log('日本語', \"q\");", 'const re = /\\d+/;'];
    const out = agent.parseCodeFromResponse(wrap([{ path: 'src/b.js', lines }]));
    expect(out.files[0].content).toBe(lines.join('\n') + '\n');
  });

  it('従来の contentBase64 も引き続き読める', () => {
    const b64 = Buffer.from('hello\n', 'utf-8').toString('base64');
    const out = agent.parseCodeFromResponse(wrap([{ path: 'a.txt', contentBase64: b64 }]));
    expect(out.files[0].content).toBe('hello\n');
  });

  it('従来の content 文字列も読める', () => {
    const out = agent.parseCodeFromResponse(wrap([{ path: 'a.txt', content: 'raw' }]));
    expect(out.files[0].content).toBe('raw');
  });

  it('本文がどの形式でも無いファイルは、握りつぶさず例外にする', () => {
    expect(() => agent.parseCodeFromResponse(wrap([{ path: 'a.txt' }]))).toThrow(/lines/);
  });

  it('lines が文字列以外を含む場合は例外にする', () => {
    expect(() => agent.parseCodeFromResponse(wrap([{ path: 'a.txt', lines: ['ok', 3] }]))).toThrow(/lines/);
  });
});

describe('CodingAgent.parseCodeFromResponse', () => {
  it('billing / quota / 429 を含む非JSON応答は usage limit ではなく通常のパースエラーにする（JSON再試行に回す）', () => {
    const agent = new CodingAgent();
    let caught: unknown;
    try {
      agent.parseCodeFromResponse('I implemented the billing page with quota checks and HTTP 429 handling.');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(LlmUsageLimitError);
  });

  it('実際の上限メッセージは LlmUsageLimitError にする', () => {
    const agent = new CodingAgent();
    expect(() => agent.parseCodeFromResponse("You've hit your usage limit. Try again at 3:00 PM."))
      .toThrow(LlmUsageLimitError);
  });
});
