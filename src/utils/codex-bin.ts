import { promises as fs } from 'fs';
import { join } from 'path';

let cachedCodexBin: string | null = null;

export async function resolveCodexBin(): Promise<string> {
  if (process.env.CODEX_BIN) {
    return process.env.CODEX_BIN;
  }

  if (cachedCodexBin) {
    return cachedCodexBin;
  }

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA;
    const userProfile = process.env.USERPROFILE;
    const extensionRoots = [
      localAppData ? join(localAppData, 'Programs', 'Microsoft VS Code', 'resources', 'app', 'extensions') : '',
      userProfile ? join(userProfile, '.vscode', 'extensions') : '',
    ].filter(Boolean);

    for (const root of extensionRoots) {
      const found = await findWindowsCodexInExtensions(root);
      if (found) {
        cachedCodexBin = found;
        return found;
      }
    }

    return 'codex.exe';
  }

  return 'codex';
}

async function findWindowsCodexInExtensions(root: string): Promise<string | null> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('openai.chatgpt-')) {
      continue;
    }

    const candidate = join(
      root,
      entry.name,
      'bin',
      'windows-x86_64',
      'codex.exe'
    );

    if (await exists(candidate)) {
      return candidate;
    }
  }

  return null;
}

async function exists(path: string): Promise<boolean> {
  return fs.stat(path).then(() => true).catch(() => false);
}
