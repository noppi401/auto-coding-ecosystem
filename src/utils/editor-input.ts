import { spawnSync } from 'child_process';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Issue #1: 外部エディタを開いて複数行テキストを入力させる。
 * 長い日本語の依頼文を、改行を含めて安全に入力するために使う。
 *
 * エディタは VISUAL / EDITOR 環境変数、なければ OS 既定（Windows: notepad / その他: vi）。
 */
export async function editTextInEditor(
  initial: string = '',
  extension: string = '.md'
): Promise<string> {
  const file = join(
    tmpdir(),
    `ecosystem-input-${Date.now()}-${Math.random().toString(36).slice(2)}${extension}`
  );
  await fs.writeFile(file, initial, 'utf-8');

  const editor =
    process.env.VISUAL ||
    process.env.EDITOR ||
    (process.platform === 'win32' ? 'notepad' : 'vi');

  try {
    const result = spawnSync(editor, [file], {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    if (result.error) throw result.error;
    return await fs.readFile(file, 'utf-8');
  } finally {
    await fs.unlink(file).catch(() => {});
  }
}
