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
import { join } from 'path';
import { homedir } from 'os';

export type PhaseMode = 'phase1+2' | 'phase1only' | 'phase2only';
export type ProjectMode = 'new' | 'modify';
export type LlmProviderChoice = 'claude' | 'codex' | 'gemini';

export interface WizardResult {
  instruction: string;
  repoName: string;
  owner: string;
  projectMode: ProjectMode;
  phaseMode: PhaseMode;
  planningModel: string;
  implModel: string;
  retryFailed: boolean;
  primaryProvider: LlmProviderChoice;
  fallbackProvider: LlmProviderChoice;
}

async function detectOwner(): Promise<string> {
  try {
    return execSync('gh api user --jq .login', { stdio: 'pipe' }).toString().trim();
  } catch {
    return process.env.GITHUB_OWNER || '';
  }
}

interface LocalRepo {
  fullName: string;
  localPath: string;
}

async function scanDirForRepos(
  dir: string,
  repos: LocalRepo[],
  seen: Set<string>,
  depth: number
): Promise<void> {
  if (depth === 0) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const repoPath = join(dir, entry.name);
    try {
      await fs.access(join(repoPath, '.git'));
      // It's a git repo — try to resolve GitHub remote
      const remoteUrl = execSync('git remote get-url origin', {
        cwd: repoPath,
        stdio: 'pipe',
      }).toString().trim();
      const match = remoteUrl.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
      if (match) {
        const fullName = `${match[1]}/${match[2]}`;
        if (!seen.has(fullName)) {
          seen.add(fullName);
          repos.push({ fullName, localPath: repoPath });
        }
      }
    } catch {
      // Not a git repo or no GitHub remote — recurse deeper
      await scanDirForRepos(repoPath, repos, seen, depth - 1);
    }
  }
}

async function detectLocalGitRepos(): Promise<LocalRepo[]> {
  const scanDirs: string[] = [
    process.env.GIT_REPOS_DIR,
    join(homedir(), 'Documents'),
    join(homedir(), 'Desktop'),
    join(homedir(), 'projects'),
    join(homedir(), 'Projects'),
  ].filter((d): d is string => Boolean(d));

  const repos: LocalRepo[] = [];
  const seen = new Set<string>();

  for (const dir of scanDirs) {
    await scanDirForRepos(dir, repos, seen, 2);
  }

  return repos;
}

const PROVIDER_OPTIONS: Array<{ value: LlmProviderChoice; label: string; hint: string }> = [
  { value: 'claude', label: 'Claude', hint: 'Anthropic Claude CLI' },
  { value: 'codex',  label: 'Codex',  hint: 'OpenAI Codex CLI' },
  { value: 'gemini', label: 'Gemini', hint: 'Google Gemini CLI' },
];

const MODEL_OPTIONS = [
  { value: 'claude-opus-4-7',           label: 'claude-opus-4',    hint: '高精度・低速' },
  { value: 'claude-sonnet-4-6',         label: 'claude-sonnet-4',  hint: 'バランス（推奨）' },
  { value: 'claude-haiku-4-5-20251001', label: 'claude-haiku-4.5', hint: '高速・低コスト' },
];

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

  // Detect GitHub owner
  const s = spinner();
  s.start('GitHub owner を検出中...');
  const detectedOwner = await detectOwner();
  s.stop('');

  // Repository selection
  let owner: string;
  let repoName: string;

  if (projectMode === 'modify') {
    const scanSpinner = spinner();
    scanSpinner.start('ローカルのリポジトリを検索中...');
    const localRepos = await detectLocalGitRepos();
    scanSpinner.stop('');

    if (localRepos.length > 0) {
      const MANUAL = '__manual__';
      const repoOptions = [
        ...localRepos.map((r) => ({ value: r.fullName, label: r.fullName, hint: r.localPath })),
        { value: MANUAL, label: '手動入力', hint: 'owner/repo 形式で直接入力する' },
      ];

      const defaultRepo = defaults.repoName
        ? (localRepos.find((r) => r.fullName.endsWith(`/${defaults.repoName}`))?.fullName ?? MANUAL)
        : repoOptions[0].value;

      const repoSelectRaw = await select({
        message: '対象リポジトリを選択',
        options: repoOptions,
        initialValue: defaultRepo,
      });
      if (isCancel(repoSelectRaw)) { outro('中止'); process.exit(0); }

      if (repoSelectRaw === MANUAL) {
        const repoRaw = await text({
          message: '対象リポジトリ (owner/repo または repo名)',
          placeholder: `${detectedOwner || 'myorg'}/my-repo`,
          initialValue: defaults.repoName ? `${defaults.owner ?? detectedOwner}/${defaults.repoName}` : '',
          validate: (v) => ((v ?? '').trim() ? undefined : 'リポジトリ名を入力してください'),
        });
        if (isCancel(repoRaw)) { outro('中止'); process.exit(0); }
        const parts = (repoRaw as string).trim().split('/');
        owner = parts.length >= 2 ? parts[0] : (detectedOwner || 'unknown');
        repoName = parts.length >= 2 ? parts[1] : parts[0];
      } else {
        const parts = (repoSelectRaw as string).split('/');
        owner = parts[0];
        repoName = parts[1];
      }
    } else {
      // No local repos found — fall back to text input
      const repoRaw = await text({
        message: '対象リポジトリ (owner/repo または repo名)',
        placeholder: `${detectedOwner || 'myorg'}/my-repo`,
        initialValue: defaults.repoName ? `${defaults.owner ?? detectedOwner}/${defaults.repoName}` : '',
        validate: (v) => ((v ?? '').trim() ? undefined : 'リポジトリ名を入力してください'),
      });
      if (isCancel(repoRaw)) { outro('中止'); process.exit(0); }
      const parts = (repoRaw as string).trim().split('/');
      owner = parts.length >= 2 ? parts[0] : (detectedOwner || 'unknown');
      repoName = parts.length >= 2 ? parts[1] : parts[0];
    }
  } else {
    // New repo — text input only
    const repoRaw = await text({
      message: '新規リポジトリ名',
      placeholder: 'my-new-repo',
      initialValue: defaults.repoName ?? '',
      validate: (v) => ((v ?? '').trim() ? undefined : 'リポジトリ名を入力してください'),
    });
    if (isCancel(repoRaw)) { outro('中止'); process.exit(0); }
    owner = detectedOwner || 'unknown';
    repoName = (repoRaw as string).trim();
  }

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

  // Primary provider
  const primaryProviderRaw = await select({
    message: '実行AI（第1候補）',
    options: PROVIDER_OPTIONS,
    initialValue: defaults.primaryProvider ?? 'claude',
  });
  if (isCancel(primaryProviderRaw)) { outro('中止'); process.exit(0); }
  const primaryProvider = primaryProviderRaw as LlmProviderChoice;

  // Fallback provider (exclude same as primary)
  const fallbackOptions = PROVIDER_OPTIONS.filter((o) => o.value !== primaryProvider);
  const defaultFallback =
    defaults.fallbackProvider && defaults.fallbackProvider !== primaryProvider
      ? defaults.fallbackProvider
      : fallbackOptions[0].value;

  const fallbackProviderRaw = await select({
    message: '実行AI（第2候補・上限時に自動切替）',
    options: fallbackOptions,
    initialValue: defaultFallback,
  });
  if (isCancel(fallbackProviderRaw)) { outro('中止'); process.exit(0); }
  const fallbackProvider = fallbackProviderRaw as LlmProviderChoice;

  // Claude model selection (applies when Claude is primary or fallback)
  const planningModel = await select({
    message: 'Planning モデル (Claude使用時)',
    options: MODEL_OPTIONS,
    initialValue: defaults.planningModel ?? 'claude-sonnet-4-6',
  });
  if (isCancel(planningModel)) { outro('中止'); process.exit(0); }

  const implModel = await select({
    message: 'Implementation モデル (Claude使用時)',
    options: MODEL_OPTIONS,
    initialValue: defaults.implModel ?? 'claude-sonnet-4-6',
  });
  if (isCancel(implModel)) { outro('中止'); process.exit(0); }

  clackLog.info(
    `準備完了 · ${owner}/${repoName} · ${phaseMode as string} · ${primaryProvider}→${fallbackProvider}`
  );

  return {
    instruction: (instructionRaw as string).trim(),
    repoName,
    owner,
    projectMode,
    phaseMode: phaseMode as PhaseMode,
    planningModel: planningModel as string,
    implModel: implModel as string,
    retryFailed: false,
    primaryProvider,
    fallbackProvider,
  };
}

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
