import {
  text,
  select,
  isCancel,
  outro,
  log as clackLog,
  spinner,
} from '@clack/prompts';
import { execSync } from 'child_process';
import { promises as fs } from 'fs';

export type PhaseMode = 'phase1+2' | 'phase1only' | 'phase2only';
export type ProjectMode = 'new' | 'modify';

export interface WizardResult {
  instruction: string;
  repoName: string;
  owner: string;
  projectMode: ProjectMode;
  phaseMode: PhaseMode;
  planningModel: string;
  implModel: string;
  retryFailed: boolean;
}

async function detectOwner(): Promise<string> {
  try {
    return execSync('gh api user --jq .login', { stdio: 'pipe' }).toString().trim();
  } catch {
    return process.env.GITHUB_OWNER || '';
  }
}

export async function showRequestWizard(
  defaults: Partial<WizardResult> = {}
): Promise<WizardResult> {
  // Project mode
  const projectModeRaw = await select({
    message: 'プロジェクトの種類',
    options: [
      { value: 'new',    label: '新規リポジトリを作成する', hint: '新しいリポジトリを作成して実装' },
      { value: 'modify', label: '既存リポジトリを改修する', hint: '既存のリポジトリに機能追加・修正' },
    ],
    initialValue: defaults.projectMode ?? 'new',
  });
  if (isCancel(projectModeRaw)) { outro('中止'); process.exit(0); }
  const projectMode = projectModeRaw as ProjectMode;

  // Detect owner early
  const s = spinner();
  s.start('GitHub owner を検出中...');
  const detectedOwner = await detectOwner();
  s.stop('');

  // Repository
  const repoRaw = await text({
    message: projectMode === 'new'
      ? '新規リポジトリ名'
      : '対象リポジトリ (owner/repo または repo名)',
    placeholder: projectMode === 'new' ? 'my-new-repo' : `${detectedOwner || 'myorg'}/my-repo`,
    initialValue: defaults.repoName
      ? (projectMode === 'new' ? defaults.repoName : `${defaults.owner}/${defaults.repoName}`)
      : '',
    validate: (v) => ((v ?? '').trim() ? undefined : 'リポジトリ名を入力してください'),
  });
  if (isCancel(repoRaw)) { outro('中止'); process.exit(0); }

  const repoParts = (repoRaw as string).trim().split('/');
  const owner = repoParts.length >= 2 ? repoParts[0] : (detectedOwner || 'unknown');
  const repoName = repoParts.length >= 2 ? repoParts[1] : repoParts[0];

  // Instruction
  const instructionRaw = await text({
    message: '指示を入力してください（自然言語）',
    placeholder: 'ユーザー認証機能を追加してください...',
    validate: (v) => ((v ?? '').trim().length >= 5 ? undefined : '5文字以上入力してください'),
  });
  if (isCancel(instructionRaw)) { outro('中止'); process.exit(0); }

  // Phase mode
  const phaseMode = await select({
    message: 'どのフェーズを実行しますか？',
    options: [
      { value: 'phase1+2',   label: 'Phase 1 + 2  (計画→実装まで自動)', hint: '推奨' },
      { value: 'phase1only', label: 'Phase 1 only  (計画のみ・Issue起票)',  hint: ''   },
      { value: 'phase2only', label: 'Phase 2 only  (既存の計画から再開)',   hint: ''   },
    ],
  });
  if (isCancel(phaseMode)) { outro('中止'); process.exit(0); }

  // Model selection
  const planningModel = await select({
    message: 'Planning モデル',
    options: [
      { value: 'claude-opus-4-7',           label: 'claude-opus-4',    hint: '高精度・低速' },
      { value: 'claude-sonnet-4-6',         label: 'claude-sonnet-4',  hint: 'バランス（推奨）' },
      { value: 'claude-haiku-4-5-20251001', label: 'claude-haiku-4.5', hint: '高速・低コスト' },
    ],
    initialValue: defaults.planningModel ?? 'claude-sonnet-4-6',
  });
  if (isCancel(planningModel)) { outro('中止'); process.exit(0); }

  const implModel = await select({
    message: 'Implementation モデル',
    options: [
      { value: 'claude-opus-4-7',           label: 'claude-opus-4',    hint: '高精度・低速' },
      { value: 'claude-sonnet-4-6',         label: 'claude-sonnet-4',  hint: 'バランス（推奨）' },
      { value: 'claude-haiku-4-5-20251001', label: 'claude-haiku-4.5', hint: '高速・低コスト' },
    ],
    initialValue: defaults.implModel ?? 'claude-sonnet-4-6',
  });
  if (isCancel(implModel)) { outro('中止'); process.exit(0); }

  clackLog.info(`準備完了 · ${owner}/${repoName} · ${phaseMode as string}`);

  return {
    instruction: (instructionRaw as string).trim(),
    repoName,
    owner,
    projectMode,
    phaseMode: phaseMode as PhaseMode,
    planningModel: planningModel as string,
    implModel: implModel as string,
    retryFailed: false,
  };
}

const MODEL_OPTIONS = [
  { value: 'claude-opus-4-7',           label: 'claude-opus-4',    hint: '高精度・低速' },
  { value: 'claude-sonnet-4-6',         label: 'claude-sonnet-4',  hint: 'バランス（推奨）' },
  { value: 'claude-haiku-4-5-20251001', label: 'claude-haiku-4.5', hint: '高速・低コスト' },
];

export async function showModelSelectWizard(
  defaults: Partial<Pick<WizardResult, 'planningModel' | 'implModel'>> = {}
): Promise<{ planningModel: string; implModel: string }> {
  const planningModel = await select({
    message: 'Planning モデル',
    options: MODEL_OPTIONS,
    initialValue: defaults.planningModel ?? 'claude-sonnet-4-6',
  });
  if (isCancel(planningModel)) { outro('中止'); process.exit(0); }

  const implModel = await select({
    message: 'Implementation モデル',
    options: MODEL_OPTIONS,
    initialValue: defaults.implModel ?? 'claude-sonnet-4-6',
  });
  if (isCancel(implModel)) { outro('中止'); process.exit(0); }

  return { planningModel: planningModel as string, implModel: implModel as string };
}
