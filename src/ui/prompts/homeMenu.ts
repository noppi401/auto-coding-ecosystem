import { intro, select, isCancel, outro } from '@clack/prompts';
import { StateManager } from '../../state/manager.js';

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
      hint: '新しい依頼を作成',
    },
    {
      value: 'issue' as HomeChoice,
      label: 'Run from Issue',
      hint: '既存リポジトリの open Issue を選んで実行',
    },
    ...(hasState ? [{
      value: 'resume' as HomeChoice,
      label: `Resume Phase 2  (${lastRepo})`,
      hint: '未完了のコーディングループに復帰',
    }] : []),
    {
      value: 'phase1only' as HomeChoice,
      label: 'Phase 1 only',
      hint: '計画のみ実行（Issue起票して停止）',
    },
    {
      value: 'status' as HomeChoice,
      label: 'Show status',
      hint: '現在のプロジェクト状態を表示',
    },
    {
      value: 'quit' as HomeChoice,
      label: 'Quit',
      hint: '',
    },
  ];

  const result = await select({
    message: '何をしますか？',
    options,
  });

  if (isCancel(result)) {
    outro('中止しました');
    process.exit(0);
  }

  return result as HomeChoice;
}
