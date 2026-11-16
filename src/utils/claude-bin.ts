import { promises as fs } from 'fs';
import { join, delimiter } from 'path';

/**
 * Windows で claude.exe の実体パスを解決する。
 *
 * `shell: true`（cmd.exe 経由）で起動すると claude -p が応答しないまま残る事象があり、
 * タイムアウト時も cmd.exe だけが終了して claude.exe が孤児化していた。
 * 実体を直接起動できるよう、PATH 上の claude.exe、または npm の claude.cmd と同じ階層にある
 * node_modules/@anthropic-ai/claude-code/bin/claude.exe を探す。
 *
 * 見つからない場合や Windows 以外では null を返し、呼び出し側は従来どおりの起動方法を使う。
 */
export async function resolveClaudeBin(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): Promise<string | null> {
  if (env.CLAUDE_BIN) {
    return env.CLAUDE_BIN;
  }
  if (platform !== 'win32') {
    return null;
  }

  const dirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    const direct = join(dir, 'claude.exe');
    if (await exists(direct)) {
      return direct;
    }

    if (await exists(join(dir, 'claude.cmd'))) {
      const npmExe = join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
      if (await exists(npmExe)) {
        return npmExe;
      }
    }
  }

  return null;
}

async function exists(path: string): Promise<boolean> {
  return fs.stat(path).then(() => true).catch(() => false);
}
