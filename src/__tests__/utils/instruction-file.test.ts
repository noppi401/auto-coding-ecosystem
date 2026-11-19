import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { readInstructionFile } from '../../utils/instruction-file.js';

describe('readInstructionFile', () => {
  let dir: string;

  beforeEach(async () => {
    dir = join(tmpdir(), `ace-instruction-file-${randomUUID()}`);
    await fs.mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function write(name: string, content: string): Promise<string> {
    const path = join(dir, name);
    await fs.writeFile(path, content, 'utf-8');
    return path;
  }

  it('.md はMarkdownをそのまま返す', async () => {
    const path = await write('req.md', '# タスク管理CLI\n\n- 追加\n- 削除\n');
    expect(await readInstructionFile(path)).toBe('# タスク管理CLI\n\n- 追加\n- 削除');
  });

  it('拡張子なし・.txt は従来どおりテキストとして読む', async () => {
    const path = await write('instruction', 'ログイン機能を追加する');
    expect(await readInstructionFile(path)).toBe('ログイン機能を追加する');
  });

  it('.html は script/style を除去し、タグを外して改行と実体参照を整える', async () => {
    const path = await write('req.HTML', [
      '<html><head><title>T</title><style>p{color:red}</style></head><body>',
      '<h1>要件</h1><script>alert("x")</script>',
      '<p>ユーザー&amp;管理者が&lt;ログイン&gt;できる</p>',
      '<ul><li>追加</li><li>削除</li></ul>',
      '</body></html>',
    ].join(''));

    const text = await readInstructionFile(path);
    expect(text).toBe('要件\nユーザー&管理者が<ログイン>できる\n- 追加\n- 削除');
  });

  it('.pdf は非対応としてエラーにする', async () => {
    const path = await write('req.pdf', '%PDF-1.4 binary');
    await expect(readInstructionFile(path)).rejects.toThrow('PDF files are not supported');
  });

  it('本文が空（タグのみのHTML）ならエラーにする', async () => {
    const path = await write('empty.html', '<html><body><script>x</script></body></html>');
    await expect(readInstructionFile(path)).rejects.toThrow('Instruction file is empty');
  });

  it('存在しないファイルはエラーにする', async () => {
    await expect(readInstructionFile(join(dir, 'missing.md'))).rejects.toThrow();
  });
});
