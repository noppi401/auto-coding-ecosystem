import { intro, select, isCancel, outro } from '@clack/prompts';
import { StateManager } from '../../state/manager.js';
import { t } from '../../utils/i18n.js';

export type HomeChoice = 'new' | 'issue' | 'resume' | 'phase1only' | 'status' | 'quit';

export async function showHomeMenu(): Promise<HomeChoice> {
  intro('▲ Auto Coding Ecosystem');

  const manager = new StateManager();
  const state = await manager.load().catch(() => null);
  const hasState = state && state.tasks.length > 0;
  const lastRepo = hasState ? `${state.githubOwner}/${state.githubRepo}` : null;

  const options = [
    {
      value: 'new' as HomeChoice,
      label: 'New request',
      hint: t('新しい依頼を作成', 'Create a new request'),
    },
    {
      value: 'issue' as HomeChoice,
      label: 'Run from Issue',
      hint: t('既存リポジトリの open Issue を選んで実行', 'Run from open Issues in an existing repository'),
    },
    ...(hasState ? [{
      value: 'resume' as HomeChoice,
      label: `Resume Phase 2  (${lastRepo})`,
      hint: t('未完了のコーディングループに復帰', 'Resume an in-progress coding loop'),
    }] : []),
    {
      value: 'phase1only' as HomeChoice,
      label: 'Phase 1 only',
      hint: t('計画のみ実行（Issue起票して停止）', 'Plan only (create Issues and stop)'),
    },
    {
      value: 'status' as HomeChoice,
      label: 'Show status',
      hint: t('現在のプロジェクト状態を表示', 'Show current project status'),
    },
    {
      value: 'quit' as HomeChoice,
      label: 'Quit',
      hint: '',
    },
  ];

  const result = await select({
    message: t('何をしますか？', 'What would you like to do?'),
    options,
  });

  if (isCancel(result)) {
    outro(t('中止しました', 'Cancelled'));
    process.exit(0);
  }

  return result as HomeChoice;
}
