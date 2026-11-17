import { describe, it, expect, vi } from 'vitest';
import { CodingAgent } from '../../agents/coding-agent.js';

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
