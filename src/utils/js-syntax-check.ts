import { execFile } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import { join, basename } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const execFileAsync = promisify(execFile);

/**
 * JS ファイル（.js / .mjs / .cjs）の構文を `node --check` で確かめる。
 * FixAgent の行単位の編集が構文エラー（括弧の崩れ・二重宣言など）を作ると、テストを実行するまで分からず、
 * 上限 3 回の修正の機会を 1 回無駄にしていたため、コミット前に検出する。
 * モジュール方式は node の自動判別に任せる（import/export があれば ES モジュールとして解釈される）。
 */
export async function checkJsSyntax(
  files: Array<{ path: string; content: string }>
): Promise<Array<{ path: string; message: string }>> {
  const targets = files.filter((f) => /\.[cm]?js$/i.test(f.path));
  if (targets.length === 0) return [];

  const dir = join(tmpdir(), `ace-syntax-${randomUUID()}`);
  await fs.mkdir(dir, { recursive: true });
  const errors: Array<{ path: string; message: string }> = [];
  try {
    for (const [i, file] of targets.entries()) {
      const tmp = join(dir, `${i}-${basename(file.path)}`);
      await fs.writeFile(tmp, file.content);
      try {
        await execFileAsync(process.execPath, ['--check', tmp], { timeout: 30000 });
      } catch (err: any) {
        const raw = String(err?.stderr || err?.message || err);
        // 一時ファイルのパスを元のパスに置き換えて、どのファイルの何行目かを分かるようにする
        errors.push({ path: file.path, message: raw.split(tmp).join(file.path).trim().slice(0, 1500) });
      }
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  return errors;
}
