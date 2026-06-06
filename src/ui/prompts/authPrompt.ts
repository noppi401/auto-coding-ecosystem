import { note, spinner, log as clackLog } from '@clack/prompts';
import { execSync } from 'child_process';
import { t } from '../../utils/i18n.js';

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
      t('GitHub CLI での認証が必要です。', 'GitHub CLI authentication is required.'),
      t('別のターミナルで以下のコマンドを実行してください:\n', 'Run the following command in another terminal:\n'),
      '  gh auth login --hostname github.com --git-protocol https --web',
      t('\n必要なスコープ: repo, workflow, read:org', '\nRequired scopes: repo, workflow, read:org'),
    ].join('\n'),
    '⚠ Action required — GitHub authentication'
  );

  const s = spinner();
  s.start(t('gh auth status を確認中... (2秒ごと)', 'Checking gh auth status... (every 2s)'));

  while (true) {
    await new Promise((r) => setTimeout(r, 2000));
    if (isGhAuthed()) {
      s.stop(t('✓ 認証完了', '✓ Authenticated'));
      return;
    }
  }
}
