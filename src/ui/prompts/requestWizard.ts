import {
  text,
  select,
  multiselect,
  isCancel,
  outro,
  log as clackLog,
  spinner,
} from '@clack/prompts';
import { execSync } from 'child_process';
import { promises as fs } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { CodexIntelligence } from '../../utils/codex-options.js';
import type { SourceIssue } from '../../state/types.js';
import { GitHubAgent } from '../../agents/github-agent.js';
import { buildIssuesInstruction } from '../../utils/issue-instruction.js';
import { loadWizardDefaults, saveWizardDefaults } from './wizardDefaults.js';
import { editTextInEditor } from '../../utils/editor-input.js';
import { t } from '../../utils/i18n.js';

export type PhaseMode = 'phase1+2' | 'phase1only' | 'phase2only';
export type ProjectMode = 'new' | 'modify';
export type LlmProviderChoice = 'claude' | 'codex' | 'gemini';
export type CodexIntelligenceChoice = 'config' | CodexIntelligence;

export interface WizardResult {
  instruction: string;
  repoName: string;
  owner: string;
  projectMode: ProjectMode;
  phaseMode: PhaseMode;
  planningModel: string;
  implModel: string;
  taskModelRouting: boolean;
  retryFailed: boolean;
  primaryProvider: LlmProviderChoice;
  fallbackProvider: LlmProviderChoice;
  codexModel?: string;
  codexIntelligence?: CodexIntelligenceChoice;
  geminiModel?: string;
  sourceIssue?: SourceIssue;
  sourceIssues?: SourceIssue[];
  /** 1=1回, N>1=N回繰り返し, 0=リミットまで */
  executionCount: number;
}

export interface RequestWizardOptions {
  forceProjectMode?: ProjectMode;
  defaultPhaseMode?: PhaseMode;
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
  { value: 'claude-opus-4-7',           label: 'claude-opus-4',    hint: t('高精度・低速', 'High accuracy, slower') },
  { value: 'claude-sonnet-4-6',         label: 'claude-sonnet-4',  hint: t('バランス（推奨）', 'Balanced (recommended)') },
  { value: 'claude-haiku-4-5-20251001', label: 'claude-haiku-4.5', hint: t('高速・低コスト', 'Fast, low cost') },
];

const CODEX_INTELLIGENCE_OPTIONS: Array<{
  value: CodexIntelligenceChoice;
  label: string;
  hint: string;
}> = [
  { value: 'config', label: t('既定値', 'Default'), hint: t('~/.codex/config.toml または Codex CLI の既定値を使う', 'Use ~/.codex/config.toml or Codex CLI default') },
  { value: 'low',    label: 'low',    hint: t('高速・軽めの推論', 'Fast, lighter reasoning') },
  { value: 'medium', label: 'medium', hint: t('速度と推論のバランス', 'Balanced speed and reasoning') },
  { value: 'high',   label: 'high',   hint: t('複雑な実装向け', 'For complex implementations') },
  { value: 'xhigh',  label: 'xhigh',  hint: t('最大推論', 'Maximum reasoning') },
];

function getDefaultCodexIntelligence(
  defaults: Partial<WizardResult>
): CodexIntelligenceChoice {
  const raw =
    defaults.codexIntelligence ||
    process.env.CODEX_INTELLIGENCE ||
    process.env.CODEX_MODEL_REASONING_EFFORT;
  return CODEX_INTELLIGENCE_OPTIONS.some((option) => option.value === raw)
    ? raw as CodexIntelligenceChoice
    : 'config';
}

function truncateOneLine(value: string, maxLength: number): string {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return oneLine.length <= maxLength
    ? oneLine
    : `${oneLine.slice(0, maxLength - 3)}...`;
}

async function selectExistingIssues(owner: string, repoName: string): Promise<SourceIssue[] | undefined> {
  const s = spinner();
  s.start(t('GitHub Issue を取得中...', 'Fetching GitHub Issues...'));

  const githubAgent = new GitHubAgent();
  let issues: SourceIssue[] = [];
  try {
    issues = await githubAgent.listOpenIssues(
      owner,
      repoName,
      Number(process.env.ISSUE_SELECT_LIMIT || '30')
    );
    s.stop('');
  } catch (err) {
    s.stop('');
    clackLog.warn(t(`Issue の取得に失敗しました。手動入力に進みます: ${String(err)}`, `Failed to fetch Issues. Falling back to manual input: ${String(err)}`));
    return undefined;
  }

  if (issues.length === 0) {
    clackLog.info(t('open Issue が見つからないため、手動入力に進みます。', 'No open Issues found. Falling back to manual input.'));
    return undefined;
  }

  const allLimit = Number(process.env.ISSUE_RUN_ALL_LIMIT || '1000');
  const scopeRaw = await select({
    message: t('Issue の実行範囲', 'Issue execution scope'),
    options: [
      { value: 'multi',  label: t('Issue を選択', 'Select Issues'),       hint: t('複数選択できます', 'Multiple selection available') },
      { value: 'all',    label: t('open Issue 全件', 'All open Issues'),   hint: t(`最大${allLimit}件まで取得して実行`, `Fetch and run up to ${allLimit} Issues`) },
      { value: 'manual', label: t('手動入力', 'Manual input'),             hint: t('Issue を使わずに依頼文を入力する', 'Enter request without using Issues') },
    ],
    initialValue: 'multi',
  });
  if (isCancel(scopeRaw)) { outro(t('中止', 'Cancelled')); process.exit(0); }

  if (scopeRaw === 'manual') {
    return undefined;
  }
  if (scopeRaw === 'all') {
    if (allLimit <= issues.length) {
      return issues;
    }

    const allSpinner = spinner();
    allSpinner.start(t('open Issue 全件を取得中...', 'Fetching all open Issues...'));
    try {
      const allIssues = await githubAgent.listOpenIssues(owner, repoName, allLimit);
      allSpinner.stop('');
      return allIssues;
    } catch (err) {
      allSpinner.stop('');
      throw err;
    }
  }

  const selectedIssueRaw = await multiselect({
    message: t('実行対象の Issue を選択', 'Select Issues to run'),
    options: issues.map((issue) => ({
      value: `issue:${issue.number}`,
      label: `#${issue.number} ${truncateOneLine(issue.title, 70)}`,
      hint: [
        issue.labels.length > 0 ? issue.labels.join(', ') : '',
        issue.updatedAt ? `updated ${issue.updatedAt.slice(0, 10)}` : '',
      ].filter(Boolean).join(' · '),
    })),
    initialValues: issues[0] ? [`issue:${issues[0].number}`] : undefined,
    required: true,
    maxItems: 12,
  });
  if (isCancel(selectedIssueRaw)) { outro(t('中止', 'Cancelled')); process.exit(0); }

  const issueNumbers = new Set(
    selectedIssueRaw.map((value) => Number(String(value).replace('issue:', '')))
  );
  return issues.filter((issue) => issueNumbers.has(issue.number));
}

function asProvider(value: string | undefined): LlmProviderChoice | undefined {
  return value === 'claude' || value === 'codex' || value === 'gemini' ? value : undefined;
}

export async function showRequestWizard(
  defaults: Partial<WizardResult> = {},
  options: RequestWizardOptions = {}
): Promise<WizardResult> {
  // Issue #2: 前回の選択値を復元する。ただし .env / CLI で明示された値（環境変数）を優先する。
  const persisted = await loadWizardDefaults();
  defaults = {
    ...persisted,
    planningModel: process.env.PLANNING_CLAUDE_MODEL || persisted.planningModel,
    implModel: process.env.IMPLEMENTATION_CLAUDE_MODEL || persisted.implModel,
    primaryProvider: asProvider(process.env.PLANNING_LLM_PROVIDER) ?? persisted.primaryProvider,
    fallbackProvider: asProvider(process.env.FALLBACK_LLM_PROVIDER) ?? persisted.fallbackProvider,
    codexModel: process.env.CODEX_MODEL || persisted.codexModel,
    geminiModel: process.env.GEMINI_MODEL || persisted.geminiModel,
    // 呼び出し元が明示した defaults は最優先で上書きする
    ...defaults,
  };

  // Project mode
  let projectMode: ProjectMode;
  if (options.forceProjectMode) {
    projectMode = options.forceProjectMode;
  } else {
    const projectModeRaw = await select({
      message: t('プロジェクトの種類', 'Project type'),
      options: [
        { value: 'new',    label: t('新規リポジトリを作成する', 'Create a new repository'),    hint: t('新しいリポジトリを作成して実装', 'Create and implement in a new repository') },
        { value: 'modify', label: t('既存リポジトリを改修する', 'Modify an existing repository'), hint: t('既存のリポジトリに機能追加・修正', 'Add features or fix an existing repository') },
      ],
      initialValue: defaults.projectMode ?? 'new',
    });
    if (isCancel(projectModeRaw)) { outro(t('中止', 'Cancelled')); process.exit(0); }
    projectMode = projectModeRaw as ProjectMode;
  }

  // Detect GitHub owner
  const s = spinner();
  s.start(t('GitHub owner を検出中...', 'Detecting GitHub owner...'));
  const detectedOwner = await detectOwner();
  s.stop('');

  // Repository selection
  let owner: string;
  let repoName: string;
  let sourceIssues: SourceIssue[] | undefined;

  if (projectMode === 'modify') {
    const scanSpinner = spinner();
    scanSpinner.start(t('ローカルのリポジトリを検索中...', 'Scanning for local repositories...'));
    const localRepos = await detectLocalGitRepos();
    scanSpinner.stop('');

    if (localRepos.length > 0) {
      const MANUAL = '__manual__';
      const repoOptions = [
        ...localRepos.map((r) => ({ value: r.fullName, label: r.fullName, hint: r.localPath })),
        { value: MANUAL, label: t('手動入力', 'Manual input'), hint: t('owner/repo 形式で直接入力する', 'Enter directly in owner/repo format') },
      ];

      const defaultRepo = defaults.repoName
        ? (localRepos.find((r) => r.fullName.endsWith(`/${defaults.repoName}`))?.fullName ?? MANUAL)
        : repoOptions[0].value;

      const repoSelectRaw = await select({
        message: t('対象リポジトリを選択', 'Select target repository'),
        options: repoOptions,
        initialValue: defaultRepo,
      });
      if (isCancel(repoSelectRaw)) { outro(t('中止', 'Cancelled')); process.exit(0); }

      if (repoSelectRaw === MANUAL) {
        const repoRaw = await text({
          message: t('対象リポジトリ (owner/repo または repo名)', 'Target repository (owner/repo or repo name)'),
          placeholder: `${detectedOwner || 'myorg'}/my-repo`,
          initialValue: defaults.repoName ? `${defaults.owner ?? detectedOwner}/${defaults.repoName}` : '',
          validate: (v) => ((v ?? '').trim() ? undefined : t('リポジトリ名を入力してください', 'Please enter a repository name')),
        });
        if (isCancel(repoRaw)) { outro(t('中止', 'Cancelled')); process.exit(0); }
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
        message: t('対象リポジトリ (owner/repo または repo名)', 'Target repository (owner/repo or repo name)'),
        placeholder: `${detectedOwner || 'myorg'}/my-repo`,
        initialValue: defaults.repoName ? `${defaults.owner ?? detectedOwner}/${defaults.repoName}` : '',
        validate: (v) => ((v ?? '').trim() ? undefined : t('リポジトリ名を入力してください', 'Please enter a repository name')),
      });
      if (isCancel(repoRaw)) { outro(t('中止', 'Cancelled')); process.exit(0); }
      const parts = (repoRaw as string).trim().split('/');
      owner = parts.length >= 2 ? parts[0] : (detectedOwner || 'unknown');
      repoName = parts.length >= 2 ? parts[1] : parts[0];
    }
    sourceIssues = await selectExistingIssues(owner, repoName);
  } else {
    // New repo — text input only
    const repoRaw = await text({
      message: t('新規リポジトリ名', 'New repository name'),
      placeholder: 'my-new-repo',
      initialValue: defaults.repoName ?? '',
      validate: (v) => ((v ?? '').trim() ? undefined : t('リポジトリ名を入力してください', 'Please enter a repository name')),
    });
    if (isCancel(repoRaw)) { outro(t('中止', 'Cancelled')); process.exit(0); }
    owner = detectedOwner || 'unknown';
    repoName = (repoRaw as string).trim();
  }

  let instruction: string;
  if (sourceIssues && sourceIssues.length > 0) {
    instruction = buildIssuesInstruction(sourceIssues);
    const issueSummary = sourceIssues.length === 1
      ? `Issue #${sourceIssues[0].number}`
      : t(`${sourceIssues.length}件のIssue`, `${sourceIssues.length} Issues`);
    clackLog.info(t(`${issueSummary} を依頼内容として使用します。`, `Using ${issueSummary} as the request content.`));
  } else {
    const inputMethodRaw = await select({
      message: t('依頼文の入力方法', 'How to enter your request'),
      options: [
        { value: 'inline', label: t('1行で入力', 'Single line input'),           hint: t('短い指示向け', 'For short instructions') },
        { value: 'editor', label: t('エディタで複数行入力', 'Multi-line editor input'), hint: t('$EDITOR / notepad を開いて改行込みで入力', 'Open $EDITOR / notepad with multi-line support') },
      ],
      initialValue: 'inline',
    });
    if (isCancel(inputMethodRaw)) { outro(t('中止', 'Cancelled')); process.exit(0); }

    if (inputMethodRaw === 'editor') {
      clackLog.info(t('エディタを開きます。入力後は保存して閉じてください。', 'Opening editor. Save and close when done.'));
      const edited = (await editTextInEditor(
        t('# ここに依頼内容を記載してください（この行は削除してかまいません）\n', '# Enter your request here (you can delete this line)\n')
      )).trim();
      if (edited.length < 5) {
        clackLog.warn(t('入力が短すぎます。1行入力に切り替えます。', 'Input too short. Switching to single-line input.'));
        const fallbackRaw = await text({
          message: t('指示を入力してください（自然言語）', 'Enter your instruction (natural language)'),
          placeholder: t('ユーザー認証機能を追加してください...', 'Add user authentication feature...'),
          validate: (v) => ((v ?? '').trim().length >= 5 ? undefined : t('5文字以上入力してください', 'Please enter at least 5 characters')),
        });
        if (isCancel(fallbackRaw)) { outro(t('中止', 'Cancelled')); process.exit(0); }
        instruction = (fallbackRaw as string).trim();
      } else {
        instruction = edited;
      }
    } else {
      const instructionRaw = await text({
        message: t('指示を入力してください（自然言語）', 'Enter your instruction (natural language)'),
        placeholder: t('ユーザー認証機能を追加してください...', 'Add user authentication feature...'),
        validate: (v) => ((v ?? '').trim().length >= 5 ? undefined : t('5文字以上入力してください', 'Please enter at least 5 characters')),
      });
      if (isCancel(instructionRaw)) { outro(t('中止', 'Cancelled')); process.exit(0); }
      instruction = (instructionRaw as string).trim();
    }
  }

  // Phase mode
  const phaseOptions = sourceIssues && sourceIssues.length > 0
    ? [
        { value: 'phase1+2',   label: t('Issue確認 + 実装', 'Review Issues + Implement'), hint: t('選択した Issue をそのまま実行', 'Execute selected Issues directly') },
        { value: 'phase1only', label: t('Issue確認のみ', 'Review Issues only'),            hint: t('内容確認ドキュメントと実行タスクを作成して停止', 'Create review document and tasks, then stop') },
      ]
    : [
        { value: 'phase1+2',   label: t('Phase 1 + 2  (計画→実装まで自動)', 'Phase 1 + 2  (plan → implement automatically)'), hint: t('推奨', 'Recommended') },
        { value: 'phase1only', label: t('Phase 1 only  (計画のみ・Issue起票)', 'Phase 1 only  (plan only, create Issues)'),      hint: '' },
        { value: 'phase2only', label: t('Phase 2 only  (既存の計画から再開)', 'Phase 2 only  (resume from existing plan)'),      hint: '' },
      ];

  const phaseMode = await select({
    message: t('どのフェーズを実行しますか？', 'Which phase(s) would you like to run?'),
    options: phaseOptions,
    initialValue: options.defaultPhaseMode ?? defaults.phaseMode ?? 'phase1+2',
  });
  if (isCancel(phaseMode)) { outro(t('中止', 'Cancelled')); process.exit(0); }

  // 処理回数（Phase 2 を自動実行する場合のみ。新規依頼・Issue 実行の双方で選択可能）
  let executionCount = 1;
  if (phaseMode === 'phase1+2') {
    const execModeRaw = await select({
      message: t('処理回数', 'Execution count'),
      options: [
        { value: '1',     label: t('1回', 'Once'),               hint: t('各タスクを1回実行して終了', 'Execute each task once and finish') },
        { value: 'multi', label: t('複数', 'Multiple'),           hint: t('指定した回数だけ繰り返し実行', 'Repeat for the specified number of times') },
        { value: 'limit', label: t('リミットまで', 'Until limit'), hint: t(`最大${process.env.PHASE2_LOOP_MAX_ATTEMPTS || '100'}回まで全タスクがマージされるまで繰り返す`, `Repeat up to ${process.env.PHASE2_LOOP_MAX_ATTEMPTS || '100'} times until all tasks are merged`) },
      ],
      initialValue: '1',
    });
    if (isCancel(execModeRaw)) { outro(t('中止', 'Cancelled')); process.exit(0); }

    if (execModeRaw === 'multi') {
      const countRaw = await text({
        message: t('実行回数を入力してください', 'Enter execution count'),
        placeholder: '3',
        initialValue: '3',
        validate: (v) => {
          const n = Number(v);
          return Number.isInteger(n) && n >= 2 ? undefined : t('2以上の整数を入力してください', 'Please enter an integer of 2 or more');
        },
      });
      if (isCancel(countRaw)) { outro(t('中止', 'Cancelled')); process.exit(0); }
      executionCount = Number(countRaw);
    } else if (execModeRaw === 'limit') {
      executionCount = 0;
    }
  }

  // Primary provider
  const primaryProviderRaw = await select({
    message: t('実行AI（第1候補）', 'AI provider (primary)'),
    options: PROVIDER_OPTIONS,
    initialValue: defaults.primaryProvider ?? 'claude',
  });
  if (isCancel(primaryProviderRaw)) { outro(t('中止', 'Cancelled')); process.exit(0); }
  const primaryProvider = primaryProviderRaw as LlmProviderChoice;

  // Fallback provider (exclude same as primary)
  const fallbackOptions = PROVIDER_OPTIONS.filter((o) => o.value !== primaryProvider);
  const defaultFallback =
    defaults.fallbackProvider && defaults.fallbackProvider !== primaryProvider
      ? defaults.fallbackProvider
      : fallbackOptions[0].value;

  const fallbackProviderRaw = await select({
    message: t('実行AI（第2候補・上限時に自動切替）', 'AI provider (fallback — auto-switch when limit reached)'),
    options: fallbackOptions,
    initialValue: defaultFallback,
  });
  if (isCancel(fallbackProviderRaw)) { outro(t('中止', 'Cancelled')); process.exit(0); }
  const fallbackProvider = fallbackProviderRaw as LlmProviderChoice;

  const usesClaude = primaryProvider === 'claude' || fallbackProvider === 'claude';
  const usesCodex = primaryProvider === 'codex' || fallbackProvider === 'codex';
  const usesGemini = primaryProvider === 'gemini' || fallbackProvider === 'gemini';

  let planningModel = defaults.planningModel ?? 'claude-sonnet-4-6';
  let implModel = defaults.implModel ?? 'claude-sonnet-4-6';
  let taskModelRouting = defaults.taskModelRouting ?? (process.env.TASK_MODEL_ROUTING === 'true');

  if (usesClaude) {
    const planningModelRaw = await select({
      message: t('Planning モデル (Claude使用時)', 'Planning model (when using Claude)'),
      options: MODEL_OPTIONS,
      initialValue: planningModel,
    });
    if (isCancel(planningModelRaw)) { outro(t('中止', 'Cancelled')); process.exit(0); }
    planningModel = planningModelRaw as string;

    const implModelRaw = await select({
      message: t('Implementation モデル (Claude使用時)', 'Implementation model (when using Claude)'),
      options: MODEL_OPTIONS,
      initialValue: implModel,
    });
    if (isCancel(implModelRaw)) { outro(t('中止', 'Cancelled')); process.exit(0); }
    implModel = implModelRaw as string;

    const routingRaw = await select({
      message: t('実装モデル自動選択（タスク複雑度に応じて）', 'Auto model selection (by task complexity)'),
      options: [
        {
          value: 'fixed',
          label: t('固定', 'Fixed'),
          hint: t('全タスクに選択したモデルを使用', 'Use selected model for all tasks'),
        },
        {
          value: 'auto',
          label: t('自動', 'Auto'),
          hint: t('low→haiku / medium→sonnet / high→opus（選択モデルが上限）', 'low→haiku / medium→sonnet / high→opus (selected model as ceiling)'),
        },
      ],
      initialValue: taskModelRouting ? 'auto' : 'fixed',
    });
    if (isCancel(routingRaw)) { outro(t('中止', 'Cancelled')); process.exit(0); }
    taskModelRouting = routingRaw === 'auto';
  }

  let codexModel: string | undefined;
  let codexIntelligence: CodexIntelligenceChoice | undefined;

  if (usesCodex) {
    const codexModelRaw = await text({
      message: t('Codex モデル (空欄なら Codex CLI の既定値)', 'Codex model (blank = Codex CLI default)'),
      placeholder: 'gpt-5.5',
      initialValue: defaults.codexModel ?? process.env.CODEX_MODEL ?? '',
    });
    if (isCancel(codexModelRaw)) { outro(t('中止', 'Cancelled')); process.exit(0); }
    codexModel = (codexModelRaw as string).trim();

    const codexIntelligenceRaw = await select({
      message: t('Codex インテリジェンス', 'Codex intelligence'),
      options: CODEX_INTELLIGENCE_OPTIONS,
      initialValue: getDefaultCodexIntelligence(defaults),
    });
    if (isCancel(codexIntelligenceRaw)) { outro(t('中止', 'Cancelled')); process.exit(0); }
    codexIntelligence = codexIntelligenceRaw as CodexIntelligenceChoice;
  }

  let geminiModel: string | undefined;

  if (usesGemini) {
    const geminiModelRaw = await text({
      message: t('Gemini モデル (空欄なら既定値)', 'Gemini model (blank = default)'),
      placeholder: 'gemini-2.5-flash',
      initialValue: defaults.geminiModel ?? process.env.GEMINI_MODEL ?? 'gemini-2.5-flash',
    });
    if (isCancel(geminiModelRaw)) { outro(t('中止', 'Cancelled')); process.exit(0); }
    geminiModel = (geminiModelRaw as string).trim() || undefined;
  }

  clackLog.info(
    t(`準備完了 · ${owner}/${repoName} · ${phaseMode as string} · ${primaryProvider}→${fallbackProvider}`,
      `Ready · ${owner}/${repoName} · ${phaseMode as string} · ${primaryProvider}→${fallbackProvider}`)
  );

  const result: WizardResult = {
    instruction,
    repoName,
    owner,
    projectMode,
    phaseMode: phaseMode as PhaseMode,
    planningModel: planningModel as string,
    implModel: implModel as string,
    taskModelRouting,
    retryFailed: false,
    primaryProvider,
    fallbackProvider,
    codexModel,
    codexIntelligence,
    geminiModel,
    sourceIssue: sourceIssues?.[0],
    sourceIssues,
    executionCount,
  };

  // Issue #2: 次回起動時の既定値として保存する（機微情報は含めない）。
  await saveWizardDefaults(result);

  return result;
}

export async function showLoopSelectWizard(): Promise<number> {
  const execModeRaw = await select({
    message: t('処理回数', 'Execution count'),
    options: [
      { value: '1',     label: t('1回', 'Once'),               hint: t('未完了タスクを1回実行して終了', 'Execute incomplete tasks once and finish') },
      { value: 'multi', label: t('複数', 'Multiple'),           hint: t('指定した回数だけ繰り返し実行', 'Repeat for the specified number of times') },
      { value: 'limit', label: t('リミットまで', 'Until limit'), hint: t(`最大${process.env.PHASE2_LOOP_MAX_ATTEMPTS || '100'}回まで全タスクがマージされるまで繰り返す`, `Repeat up to ${process.env.PHASE2_LOOP_MAX_ATTEMPTS || '100'} times until all tasks are merged`) },
    ],
    initialValue: '1',
  });
  if (isCancel(execModeRaw)) { outro(t('中止', 'Cancelled')); process.exit(0); }

  if (execModeRaw === 'multi') {
    const countRaw = await text({
      message: t('実行回数を入力してください', 'Enter execution count'),
      placeholder: '3',
      initialValue: '3',
      validate: (v) => {
        const n = Number(v);
        return Number.isInteger(n) && n >= 2 ? undefined : t('2以上の整数を入力してください', 'Please enter an integer of 2 or more');
      },
    });
    if (isCancel(countRaw)) { outro(t('中止', 'Cancelled')); process.exit(0); }
    return Number(countRaw);
  }

  return execModeRaw === 'limit' ? 0 : 1;
}

export async function showModelSelectWizard(
  defaults: Partial<Pick<WizardResult, 'planningModel' | 'implModel'>> = {}
): Promise<{ planningModel: string; implModel: string }> {
  const planningModel = await select({
    message: t('Planning モデル', 'Planning model'),
    options: MODEL_OPTIONS,
    initialValue: defaults.planningModel ?? 'claude-sonnet-4-6',
  });
  if (isCancel(planningModel)) { outro(t('中止', 'Cancelled')); process.exit(0); }

  const implModel = await select({
    message: t('Implementation モデル', 'Implementation model'),
    options: MODEL_OPTIONS,
    initialValue: defaults.implModel ?? 'claude-sonnet-4-6',
  });
  if (isCancel(implModel)) { outro(t('中止', 'Cancelled')); process.exit(0); }

  return { planningModel: planningModel as string, implModel: implModel as string };
}
