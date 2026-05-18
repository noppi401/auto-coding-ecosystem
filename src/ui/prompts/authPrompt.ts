import { note, spinner, log as clackLog } from '@clack/prompts';
import { execSync } from 'child_process';

function isGhAuthed(): boolean {
  try {
    execSync('gh auth status', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export async function ensureGhAuth(): Promise<void> {
  if (isGhAuthed()) return;

  note(
    [
      'GitHub CLI での認証が必要です。',
      '別のターミナルで以下のコマンドを実行してください:\n',
      '  gh auth login --hostname github.com --git-protocol https --web',
      '\n必要なスコープ: repo, workflow, read:org',
    ].join('\n'),
    '⚠ Action required — GitHub authentication'
  );

  const s = spinner();
  s.start('gh auth status を確認中... (2秒ごと)');

  while (true) {
    await new Promise((r) => setTimeout(r, 2000));
    if (isGhAuthed()) {
      s.stop('✓ 認証完了');
      return;
    }
  }
}
