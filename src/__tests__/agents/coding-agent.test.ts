import { describe, it, expect, vi } from 'vitest';
import { CodingAgent } from '../../agents/coding-agent.js';

vi.mock('../../utils/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), section: vi.fn() },
}));

const wrap = (files: unknown[]) =>
  JSON.stringify({ files, commitMessage: 'feat: x', prTitle: 't', prBody: 'b' });

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
