import { promises as fs } from 'fs';
import { randomUUID } from 'crypto';
import { dirname } from 'path';
import { StateManager } from './state/manager.js';
import { ProjectState, ReviewComment, ReviewResult, SourceIssue, Task, TaskCheckResult } from './state/types.js';
import { logger } from './utils/logger.js';
import { RequirementsAgent } from './agents/requirements-agent.js';
import { RequirementsValidationAgent } from './agents/requirements-validation-agent.js';
import { DesignAgent } from './agents/design-agent.js';
import { DesignValidationAgent } from './agents/design-validation-agent.js';
import { TaskDecompAgent } from './agents/task-decomp-agent.js';
import { RepoContextSummaryAgent } from './agents/repo-context-summary-agent.js';
import { CodingAgent, CodeOutput } from './agents/coding-agent.js';
import { AcceptanceTestAgent } from './agents/acceptance-test-agent.js';
import { buildAcceptanceTask } from './utils/acceptance-task.js';
import { CodexAgent } from './agents/codex-agent.js';
import { ReviewAgent } from './agents/review-agent.js';
import { FixAgent } from './agents/fix-agent.js';
import { GitHubAgent } from './agents/github-agent.js';
import { isLlmUsageLimitError } from './utils/llm-errors.js';
import { resolveTaskModel } from './utils/model-routing.js';
import { extractRelevantDoc, isDocRelevanceEnabled } from './utils/doc-relevance.js';
import { trimPrDiff } from './utils/diff-trim.js';
import { describeOtherTasks } from './utils/other-tasks.js';
import { fetchPrDiffAfterFix } from './utils/refetch-diff.js';
import { findUnexecutedTestFiles } from './utils/unexecuted-tests.js';
import { guardUnshownOverwrites } from './utils/fix-overwrite-guard.js';
import { modifiedFilesInDiff } from './utils/modified-files.js';
import { entryFileFromStartScript } from './utils/smoke-check.js';

// レビュー・修正で常に参照させるプロジェクト設定（モジュール方式・ビルド・スクリプトの前提を誤解させないため）
const PROJECT_CONFIG_FILES = ['package.json', 'tsconfig.json'];
import { parseTestOutput, formatTestFailureComment } from './utils/parse-test-output.js';
import { parseCoverageOutput, formatCoverageComment } from './utils/parse-coverage.js';
import { selectInstallCommand } from './utils/package-manager.js';

const VALIDATION_PASS_THRESHOLD = parseInt(process.env.VALIDATION_SCORE_THRESHOLD || '70');
const VALIDATION_MAX_ITERATIONS = parseInt(process.env.VALIDATION_MAX_ITERATIONS || '2');

type IssueSplitMode = 'auto' | 'always' | 'never';

interface IssueSplitDecision {
  shouldSplit: boolean;
  reasons: string[];
  metrics: {
    bodyChars: number;
    numberedItems: number;
    targetFiles: number;
    codeAreas: number;
  };
}

interface PlannedIssueTasks {
  sourceIssue: SourceIssue;
  tasks: Task[];
  split: boolean;
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function commandLine(command: string, args: string[]): string {
  return [command, ...args].join(' ');
}

function summarizeOutput(output: string, maxChars: number = 500): string {
  return output.replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

const ISSUE_SPLIT_MODE = ((process.env.ISSUE_SPLIT_MODE || 'auto').toLowerCase()) as IssueSplitMode;
const ISSUE_SPLIT_BODY_CHARS = readPositiveIntEnv('ISSUE_SPLIT_BODY_CHARS', 2000);
const ISSUE_SPLIT_NUMBERED_ITEMS = readPositiveIntEnv('ISSUE_SPLIT_NUMBERED_ITEMS', 4);
const ISSUE_SPLIT_TARGET_FILES = readPositiveIntEnv('ISSUE_SPLIT_TARGET_FILES', 4);
const ISSUE_SPLIT_MAX_TARGET_FILES_PER_TASK = readPositiveIntEnv('ISSUE_SPLIT_MAX_TARGET_FILES_PER_TASK', 4);

export class Orchestrator {
  private stateManager: StateManager;
  private githubAgent: GitHubAgent;
  private maxReviewIterations: number;

  constructor(statePath: string = '.ecosystem/state.json') {
    this.stateManager = new StateManager(statePath);
    this.githubAgent = new GitHubAgent();
    this.maxReviewIterations = parseInt(
      process.env.MAX_REVIEW_ITERATIONS || '5'
    );
  }

  async runPhase1(
    instruction: string,
    owner: string,
    repo: string,
    options: {
      projectMode?: ProjectState['projectMode'];
      sourceIssue?: SourceIssue;
      sourceIssues?: SourceIssue[];
      /**
       * Issue #3: タスク分解後・GitHub Issue 起票前に呼ばれる承認コールバック。
       * false を返すと Issue を起票せず Phase 1 を中止する（phase='aborted'）。
       * 未指定なら従来どおり確認なしで起票する（--auto / 自動実行）。
       */
      confirmTasks?: (tasks: Task[]) => Promise<boolean>;
    } = {}
  ): Promise<ProjectState> {
    logger.section('PHASE 1: REQUIREMENTS → DESIGN → TASKS');

    const projectMode = options.projectMode || 'new';
    const sourceIssues =
      options.sourceIssues && options.sourceIssues.length > 0
        ? options.sourceIssues
        : options.sourceIssue
          ? [options.sourceIssue]
          : [];
    const githubAgent = new GitHubAgent();
    let repositoryContext: string | undefined;

    if (projectMode === 'modify') {
      logger.info('Loading existing repository context...', `${owner}/${repo}`);
      repositoryContext = await githubAgent.getRepositoryContext(owner, repo);
    }

    const state = await this.stateManager.initialize(
      instruction,
      owner,
      repo,
      {
        projectMode,
        repositoryContext,
        sourceIssue: sourceIssues[0],
        sourceIssues,
      }
    );

    if (projectMode === 'new') {
      // Create GitHub repository
      logger.info('Creating GitHub repository...', `${owner}/${repo}`);
      try {
        await githubAgent.createRepo(owner, repo);
      } catch (err) {
        const errMsg = String(err);
        if (errMsg.includes('already exists')) {
          logger.info('Repository already exists, using existing repo');
        } else {
          logger.error('Failed to create repository', err);
          throw err;
        }
      }
    } else {
      logger.info('Using existing repository for modification', `${owner}/${repo}`);
    }

    // Issue #7: 大きなリポジトリコンテキストを一度だけ要約し、後続エージェントで再利用する。
    const planningContext = await this._summarizeRepoContextIfEnabled(repositoryContext);

    if (sourceIssues.length > 0) {
      return await this._runIssueOnlyPlanning(
        sourceIssues,
        instruction,
        owner,
        repo,
        planningContext
      );
    }

    // Phase 1a+1b: Requirements Generation + Validation Loop
    logger.section('Step 1-2/5: Requirements Generation + Validation');
    const reqAgent = new RequirementsAgent();
    const requirementsDoc = await this._requirementsWithValidation(
      reqAgent,
      instruction,
      planningContext
    );

    await this.stateManager.updateRequirementsDoc(requirementsDoc);
    let currentState = await this.stateManager.load();
    if (!currentState) throw new Error('Failed to load state');
    currentState.agentHistories.requirements = reqAgent.getHistory();
    await this.stateManager.save(currentState);

    // Phase 1c+1d: Design Generation + Validation Loop
    logger.section('Step 3-4/5: Design Generation + Validation');
    const designAgent = new DesignAgent();
    const designDoc = await this._designWithValidation(
      designAgent,
      requirementsDoc,
      planningContext
    );

    await this.stateManager.updateDesignDoc(designDoc);
    currentState = await this.stateManager.load();
    if (!currentState) throw new Error('Failed to load state');
    currentState.agentHistories.design = designAgent.getHistory();
    await this.stateManager.save(currentState);

    // Phase 1e: Task Decomposition
    logger.section('Step 5/5: Task Decomposition');
    const taskAgent = new TaskDecompAgent();
    const tasks = await taskAgent.decomposeTask(
      requirementsDoc,
      designDoc
    );
    // 最後に受け入れ確認タスクを追加する（要件から独立に書いた受け入れテスト + 起動確認で、要件を満たすかを確かめる）
    if (process.env.ACCEPTANCE_TASK_ENABLED !== 'false') {
      tasks.push(buildAcceptanceTask(tasks));
    }

    // Issue #3: Issue 起票前にタスク一覧の承認を求める（コールバックがある場合のみ）
    if (options.confirmTasks) {
      const approved = await options.confirmTasks(tasks);
      if (!approved) {
        logger.warn('Task plan was not approved; aborting before GitHub issue creation');
        const aborted = await this.stateManager.load();
        if (aborted) {
          aborted.phase = 'aborted';
          await this.stateManager.save(aborted);
          return aborted;
        }
      }
    }

    logger.section('Step 5/5: GitHub Issue Registration');
    await this._createIssuesForTasks(tasks, owner, repo, sourceIssues[0]);

    await this.stateManager.setTasks(tasks);
    if (sourceIssues[0]) {
      try {
        await this._commentSourceIssueWithTasks(sourceIssues[0], tasks, owner, repo);
      } catch (err) {
        logger.warn('Failed to comment source issue with generated task list; continuing', String(err));
      }
    }
    currentState = await this.stateManager.load();
    if (!currentState) throw new Error('Failed to load state');
    currentState.agentHistories.taskDecomp = taskAgent.getHistory();
    await this.stateManager.save(currentState);

    logger.section('PHASE 1 COMPLETE');
    logger.info('Requirements generation complete', {
      taskCount: tasks.length,
    });

    return currentState;
  }

  async runPhase2(retryFailed: boolean = false): Promise<void> {
    logger.section('PHASE 2: CODING LOOP');

    const state = await this.stateManager.load();
    if (!state || !state.tasks || state.tasks.length === 0) {
      throw new Error('No state or tasks to process');
    }

    logger.info(
      'Starting issue-driven coding loop',
      `${state.tasks.length} tasks; one active issue/PR at a time`
    );

    for (let i = 0; i < state.tasks.length; i++) {
      const task = state.tasks[i];

      if (retryFailed && task.status === 'failed') {
        logger.info('Retrying failed task', task.title);
        task.status = 'pending';
        task.errorMessage = undefined;
        task.reviewIteration = 0;
      }

      const resumableStatuses = new Set<Task['status']>([
        'coding',
        'pr_open',
        'in_review',
        'fixing',
      ]);
      const shouldProcess =
        task.status === 'pending' ||
        resumableStatuses.has(task.status) ||
        (retryFailed && task.status === 'failed');

      if (!shouldProcess) {
        logger.info('Skipping task', {
          task: task.title,
          status: task.status,
        });
        continue;
      }

      await this.stateManager.setCurrentTaskIndex(i);
      logger.section(`ISSUE TASK ${i + 1}/${state.tasks.length}: ${task.title}`);

      try {
        await this._processTask(task, state, retryFailed);
        await this.stateManager.updateTask(task.id, {
          status: 'merged',
          errorMessage: undefined,
        });
      } catch (err) {
        if (isLlmUsageLimitError(err)) {
          logger.error(`${err.provider} usage limit reached; stopping Phase 2 immediately`, err);
          await this.stateManager.updateTask(task.id, {
            status: 'failed',
            errorMessage: `AI usage limit reached: ${String(err)}`,
          });
          logger.warn(
            'Token limit reached — wait for the limit to reset, then resume with',
            `npm run dev -- phase2 --retry-failed`
          );
          throw err;
        }

        logger.error(`Task failed: ${task.title}`, err);
        await this.stateManager.updateTask(task.id, {
          status: 'failed',
          errorMessage: String(err),
        });

        logger.warn(
          'Stopping Phase 2 so only one unresolved issue/PR remains active',
          `Resume with: npm run dev -- phase2 --retry-failed`
        );
        return;
      }
    }

    const latestState = await this.stateManager.load();
    const remainingFailedCount =
      latestState?.tasks.filter((latestTask) => latestTask.status === 'failed').length ?? 0;
    const remainingUnmergedCount =
      latestState?.tasks.filter((latestTask) => latestTask.status !== 'merged').length ?? 0;
    const remainingSkippedCount =
      latestState?.tasks.filter((latestTask) => latestTask.status === 'skipped').length ?? 0;

    if (remainingFailedCount > 0 || remainingUnmergedCount > 0) {
      logger.warn(
        'PHASE 2 paused with remaining tasks',
        `${remainingFailedCount}/${state.tasks.length} tasks failed, ${remainingSkippedCount}/${state.tasks.length} skipped, ${remainingUnmergedCount}/${state.tasks.length} not merged`
      );
      return;
    }

    if (latestState) {
      await this._verifyContextWorktreeSynced(latestState);
      await this._closeSourceIssueIfNeeded(latestState);
    }

    await this.stateManager.markCompleted();
    logger.section('PHASE 2 COMPLETE - ALL TASKS DONE');
  }

  /**
   * per-task モデルルーティングが有効なら、タスクの complexity に応じた実装モデルを
   * 実装系エージェント（CodingAgent / FixAgent）へ適用する。
   * 無効時・上書き不要時は何もしない（env ベースのモデルがそのまま使われる）。
   */
  private _applyTaskModel(
    agent: { setModelOverride(model: string | null): void },
    task: Task
  ): void {
    const model = resolveTaskModel(task.complexity, process.env.IMPLEMENTATION_CLAUDE_MODEL);
    if (!model) return;
    agent.setModelOverride(model);
    logger.info('Per-task model routing applied', {
      task: task.title,
      complexity: task.complexity || 'medium (default)',
      model,
    });
  }

  /**
   * npm test を実行できない（package.json や有効な test script が無い）場合も、テストを素通りさせない。
   * JS のテストファイルがあれば `node --test <files>` で直接実行し、失敗は blocking にする。
   * （run 30: package.json を作るタスクが後ろにあり、それまでのタスクがテスト未実行のままマージされた）
   */
  private async _runNodeTestFallback(
    githubAgent: GitHubAgent,
    state: ProjectState,
    task: Task,
    comments: ReviewComment[],
    reason: string
  ): Promise<void> {
    const ls = await githubAgent.runCommandInWorktree(
      state.githubOwner, state.githubRepo, task.branchName, 'git', ['ls-files'], 30000
    );
    const testFiles = (ls?.stdout ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /\.(?:test|spec)\.[cm]?js$/.test(l));
    if (testFiles.length === 0) {
      await this._recordTaskCheck(task, {
        name: 'test',
        status: 'skipped',
        summary: `${reason}ため npm test を未実行（実行できる JS のテストファイルも無い）`,
      });
      return;
    }

    const args = ['--test', ...testFiles];
    const command = commandLine('node', args);
    logger.info(`Running tests directly because ${reason === 'package.json がない' ? 'package.json is missing' : 'no test script'}...`, command);
    const result = await githubAgent.runCommandInWorktree(
      state.githubOwner, state.githubRepo, task.branchName, 'node', args, 120000
    );
    if (result.exitCode === 0 && !result.timedOut) {
      await this._recordTaskCheck(task, {
        name: 'test',
        status: 'passed',
        summary: `${reason}ため node --test で直接実行して通過（${testFiles.length} ファイル）`,
        command,
        exitCode: 0,
      });
      return;
    }

    const output = (result.stdout + '\n' + result.stderr).trim();
    logger.warn('Direct node --test failed', `exit code: ${result.exitCode}`);
    await this._recordTaskCheck(task, {
      name: 'test',
      status: 'failed',
      summary: `${reason}ため node --test で直接実行して失敗`,
      command,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      severity: 'blocking',
      details: summarizeOutput(output, 1500),
    });
    comments.push({
      path: 'package.json',
      line: 1,
      body: `**テスト失敗**\n\n${reason}ため \`${command}\` で直接テストを実行し、失敗しました。実装（またはテストの不具合）を直してください。テストを実行対象から外して通すことは禁止です。\n\n\`\`\`\n${output.slice(0, 3000)}\n\`\`\``,
      severity: 'blocking',
    });
  }

  /**
   * CodingAgent に参照用として渡す、プロジェクトの文脈（設定ファイルの内容とファイル一覧）。
   * 新規ファイルだけを作るタスクでも、モジュール方式・テストの慣習・既存のヘルパーを知れるようにする。
   */
  private async _buildProjectContext(githubAgent: GitHubAgent, state: ProjectState, task: Task): Promise<string> {
    const config = await githubAgent.readFiles(state.githubOwner, state.githubRepo, task.branchName, PROJECT_CONFIG_FILES);
    const ls = await githubAgent.runCommandInWorktree(
      state.githubOwner, state.githubRepo, task.branchName, 'git', ['ls-files'], 30000
    );
    const files = (ls?.stdout ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
    const parts = Object.entries(config).map(([path, content]) => `${path}:\n${content.substring(0, 4000)}`);
    if (files.length > 0) parts.push(`FILES IN THE REPOSITORY:\n${files.slice(0, 300).map((f) => `- ${f}`).join('\n')}`);
    return parts.join('\n\n');
  }

  /**
   * Issue #8: IMPL_DOC_RELEVANCE=true のとき、要件・設計書をタスク関連部分に絞り込む。
   * 無効時は state の全文をそのまま返す（現行挙動を維持）。
   */
  private _buildImplementationDocs(
    task: Task,
    state: ProjectState
  ): { requirementsDoc: string; designDoc: string } {
    if (!isDocRelevanceEnabled()) {
      return { requirementsDoc: state.requirementsDoc, designDoc: state.designDoc };
    }

    const reqMax = Number(process.env.IMPL_DOC_MAX_CHARS || '6000');
    const designMax = Number(process.env.IMPL_DESIGN_DOC_MAX_CHARS || '4000');
    const requirementsDoc = extractRelevantDoc(state.requirementsDoc, task, reqMax);
    const designDoc = extractRelevantDoc(state.designDoc, task, designMax);

    logger.info('Implementation docs narrowed to task-relevant sections', {
      task: task.title,
      requirements: `${state.requirementsDoc.length} -> ${requirementsDoc.length} chars`,
      design: `${state.designDoc.length} -> ${designDoc.length} chars`,
    });

    return { requirementsDoc, designDoc };
  }

  private async _processTask(
    task: Task,
    state: ProjectState,
    retryFailed: boolean = false
  ): Promise<void> {
    const githubAgent = new GitHubAgent();

    if (
      task.prNumber &&
      (retryFailed ||
        task.status === 'coding' ||
        task.status === 'pr_open' ||
        task.status === 'in_review' ||
        task.status === 'fixing' ||
        task.status === 'failed')
    ) {
      logger.info('Resuming existing PR...', `#${task.prNumber}`);
      const reviewAgent = new ReviewAgent();
      const currentState = await this.stateManager.load();
      if (!currentState) throw new Error('Failed to load state');
      if (currentState.agentHistories.review) {
        reviewAgent.setSessionId(currentState.agentHistories.review);
      }
      await this._reviewLoop(task, githubAgent, reviewAgent, state, task.prNumber);
      return;
    }

    // Create branch
    logger.info('Creating branch...', task.branchName);
    await this.stateManager.updateTask(task.id, {
      status: 'coding',
      errorMessage: undefined,
    });

    await githubAgent.createBranch(
      state.githubOwner,
      state.githubRepo,
      task.branchName
    );
    // 新規プロジェクトでも、前のタスクが作った同名ファイルがあり得る。存在するものは必ず読み込んで渡す
    // （見せないと全文を書き直して既存の実装・テストを消す）。存在しないパスは readFiles が無視する。
    const currentTargetFiles = await githubAgent.readFiles(
      state.githubOwner,
      state.githubRepo,
      task.branchName,
      [...new Set([...task.targetFiles, ...(task.testFiles ?? [])])]
    );

    // Generate code
    logger.info(
      'Generating code with implementation LLM...',
      process.env.IMPLEMENTATION_LLM_PROVIDER || 'claude'
    );
    let codingAgent: CodingAgent;
    let codeOutput: CodeOutput;
    if (task.kind === 'acceptance') {
      // 受け入れタスク: 実装を見ない別エージェントが、要件だけから受け入れテストを書く
      const acceptanceAgent = new AcceptanceTestAgent();
      codingAgent = acceptanceAgent;
      const pkg = await githubAgent.readFiles(state.githubOwner, state.githubRepo, task.branchName, ['package.json']);
      const ls = await githubAgent.runCommandInWorktree(
        state.githubOwner, state.githubRepo, task.branchName, 'git', ['ls-files'], 30000
      );
      const trackedFiles = (ls?.stdout ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
      codeOutput = await acceptanceAgent.generateAcceptanceTests(task, state.requirementsDoc, pkg['package.json'], trackedFiles);
    } else {
      codingAgent = new CodingAgent();
      this._applyTaskModel(codingAgent, task);
      const { requirementsDoc, designDoc } = this._buildImplementationDocs(task, state);
      codeOutput = await codingAgent.generateCode(
        task,
        requirementsDoc,
        designDoc,
        currentTargetFiles,
        describeOtherTasks(state.tasks, task),
        await this._buildProjectContext(githubAgent, state, task)
      );
    }

    let currentState = await this.stateManager.load();
    if (!currentState) throw new Error('Failed to load state');
    currentState.agentHistories.coding = codingAgent.getHistory();
    await this.stateManager.save(currentState);

    // Commit files
    logger.info('Committing files...');
    const committed = await githubAgent.commitFiles(
      state.githubOwner,
      state.githubRepo,
      task.branchName,
      codeOutput.files,
      codeOutput.commitMessage
    );
    if (!committed) {
      throw new Error(
        [
          `CodingAgent wrote ${codeOutput.files.length} file(s), but git detected no diff on ${task.branchName}.`,
          'Generated content may be identical to the branch HEAD.',
          `Files: ${codeOutput.files.map((file) => file.path).join(', ') || '(none)'}`,
        ].join(' ')
      );
    }

    // Create PR
    logger.info('Creating PR...');
    const prBody = [
      codeOutput.prBody,
      task.issueNumber ? `\n\nTracked issue: #${task.issueNumber}` : '',
    ].join('');
    const prInfo = await githubAgent.createPr(
      state.githubOwner,
      state.githubRepo,
      task.branchName,
      codeOutput.prTitle,
      prBody
    );

    await this.stateManager.updateTask(task.id, {
      status: 'pr_open',
      prNumber: prInfo.prNumber,
      prUrl: prInfo.prUrl,
      errorMessage: undefined,
    });

    if (task.issueNumber) {
      try {
        await githubAgent.commentIssue(
          state.githubOwner,
          state.githubRepo,
          task.issueNumber,
          `Implementation PR opened: #${prInfo.prNumber}\n\n${prInfo.prUrl}`
        );
      } catch (err) {
        logger.warn('Failed to comment issue with PR link; continuing', String(err));
      }
    }

    // Review loop
    const reviewAgent = new ReviewAgent();
    currentState = await this.stateManager.load();
    if (!currentState) throw new Error('Failed to load state');
    if (currentState.agentHistories.review) {
      reviewAgent.setSessionId(currentState.agentHistories.review);
    }

    await this._reviewLoop(task, githubAgent, reviewAgent, state, prInfo.prNumber);
  }

  private async _reviewLoop(
    task: Task,
    githubAgent: GitHubAgent,
    reviewAgent: ReviewAgent,
    state: ProjectState,
    prNumber: number
  ): Promise<void> {
    let iteration = 0;
    let lastFixInputDiff: string | null = null;
    // 修正をコミットした直後のみ設定。push 直後の古い diff を掴まないよう再取得の基準にする。
    let diffBaselineAfterFix: string | null = null;

    while (iteration < this.maxReviewIterations) {
      iteration++;
      logger.info(
        `Review iteration ${iteration}/${this.maxReviewIterations}...`
      );

      // Get PR info（Issue #6: 巨大 diff はトリミングしてレビュー/修正のトークンを抑える）
      const { raw: rawPrDiff, trimmed: prDiff } = await fetchPrDiffAfterFix(
        () => this.githubAgent.getPrDiff(state.githubOwner, state.githubRepo, prNumber),
        diffBaselineAfterFix,
        trimPrDiff
      );
      diffBaselineAfterFix = null;
      if (prDiff.length < rawPrDiff.length) {
        logger.info(
          'PR diff trimmed before review',
          `${rawPrDiff.length} -> ${prDiff.length} chars`
        );
      }
      const diffUnchangedAfterFix =
        iteration > 1 && lastFixInputDiff === prDiff;

      // Build / test check (deterministic, runs before LLM review)
      const buildComments = await this._runBuildCheck(githubAgent, state, task);

      // Review
      const otherTasksContext = describeOtherTasks(state.tasks, task);
      // 差分外の定義を「未定義」と誤検知しないよう、変更された既存ファイルの全文も渡す
      // 設定ファイルも常に渡す（モジュール方式などを誤解した指摘を防ぐ。存在しないものは readFiles が無視する）
      const modifiedFileContents = await this.githubAgent.readFiles(
        state.githubOwner, state.githubRepo, task.branchName,
        [...new Set([...PROJECT_CONFIG_FILES, ...modifiedFilesInDiff(rawPrDiff)])]
      );
      const reviewResult =
        iteration === 1
          ? await reviewAgent.reviewPr(
              task,
              prDiff,
              state.requirementsDoc,
              state.designDoc,
              otherTasksContext,
              modifiedFileContents
            )
          : await reviewAgent.reReviewAfterFix(task, prDiff, otherTasksContext, modifiedFileContents);

      const combinedReviewResult = await this._runCodexReviewIfEnabled(
        task,
        prDiff,
        state,
        reviewResult
      );

      // Detect test deletions / disabling in the diff (deterministic, before LLM review)
      const testRegressionComments = this._detectTestDeletion(rawPrDiff);
      if (testRegressionComments.length > 0) {
        await this._recordTaskCheck(task, {
          name: 'test-regression',
          status: 'failed',
          summary: `${testRegressionComments.length} 件のテスト退行を検出`,
          severity: 'blocking',
          details: testRegressionComments.map((comment) => `${comment.path}: ${comment.body}`).join('\n\n').slice(0, 2000),
        });
        combinedReviewResult.comments = [...testRegressionComments, ...combinedReviewResult.comments];
        combinedReviewResult.approved = false;
      } else {
        await this._recordTaskCheck(task, {
          name: 'test-regression',
          status: 'passed',
          summary: 'PR diff にテスト削除・無効化・アサーション削除は検出されませんでした',
        });
      }

      // Prepend build/test failures as blocking comments
      if (buildComments.length > 0) {
        combinedReviewResult.comments = [...buildComments, ...combinedReviewResult.comments];
        combinedReviewResult.approved = false;
      }
      const blockingComments = this.getBlockingComments(combinedReviewResult);
      const suggestionComments = this.getSuggestionComments(combinedReviewResult);
      const shouldMerge =
        combinedReviewResult.approved ||
        blockingComments.length === 0 ||
        (iteration === this.maxReviewIterations && blockingComments.length === 0);

      // Save review history
      await this.stateManager.updateTask(task.id, {
        reviewIteration: iteration,
        status: 'in_review',
        errorMessage: undefined,
      });

      let currentState = await this.stateManager.load();
      if (!currentState) throw new Error('Failed to load state');
      currentState.agentHistories.review = reviewAgent.getHistory();
      await this.stateManager.save(currentState);

      // Post review comments
      if (combinedReviewResult.comments.length > 0) {
        await githubAgent.postReviewComments(
          state.githubOwner,
          state.githubRepo,
          prNumber,
          combinedReviewResult.comments
        );
      }

      if (shouldMerge) {
        if (!combinedReviewResult.approved && suggestionComments.length > 0) {
          logger.info(
            'No blocking review comments remain; merging with suggestions noted',
            `${suggestionComments.length} suggestions`
          );
        } else {
          logger.info('PR APPROVED! Merging...');
        }

        await githubAgent.approvePr(
          state.githubOwner,
          state.githubRepo,
          prNumber,
          combinedReviewResult.summary
        );

        await githubAgent.mergePr(
          state.githubOwner,
          state.githubRepo,
          prNumber
        );

        const syncInfo = await githubAgent.syncContextWorktree(
          state.githubOwner,
          state.githubRepo
        );
        logger.info(
          'Context worktree synchronized after merge',
          `${syncInfo.branch}@${syncInfo.commit.slice(0, 12)} ${syncInfo.path}`
        );
        const productSyncInfo = await githubAgent.syncProductWorktree(
          state.githubOwner,
          state.githubRepo
        );
        if (productSyncInfo) {
          logger.info(
            'Product worktree synchronized after merge',
            `${productSyncInfo.branch}@${productSyncInfo.commit.slice(0, 12)} ${productSyncInfo.path}`
          );
        }

        if (task.issueNumber) {
          await githubAgent.closeIssue(
            state.githubOwner,
            state.githubRepo,
            task.issueNumber,
            `Completed by merged PR #${prNumber}.`
          );
        }

        break;
      } else if (diffUnchangedAfterFix) {
        logger.warn(
          'Stopping review loop because PR diff did not change',
          `Remaining blocking comments: ${blockingComments.length}`
        );

        await githubAgent.requestChanges(
          state.githubOwner,
          state.githubRepo,
          prNumber,
          [
            'Automated review stopped because the latest fix did not change the PR diff.',
            `Remaining blocking comments: ${blockingComments.length}`,
            combinedReviewResult.summary,
          ].join('\n\n')
        );

        throw new Error(
          `Task approval stopped because diff did not change and ${blockingComments.length} blocking comments remain`
        );
      } else if (iteration < this.maxReviewIterations) {
        // Fix and retry
        logger.info(
          'Fixing blocking review comments...',
          `${blockingComments.length} blocking comments`
        );

        // Extract changed file paths from the diff so FixAgent has real file contents
        // 指摘が差分外のファイルを指す場合も、内容を渡す（見ていないファイルを新規扱いで上書きさせない）
        // タスクの対象ファイルも渡す（受け入れタスクでは全実装ファイルが対象で、失敗の原因は差分の外の実装側にある）
        const changedPaths = [...new Set([
          ...[...prDiff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map(m => m[1]),
          ...blockingComments.map(c => c.path).filter(Boolean),
          ...task.targetFiles,
          ...PROJECT_CONFIG_FILES,
        ])];
        const currentFiles: { [path: string]: string } = changedPaths.length > 0
          ? await this.githubAgent.readFiles(state.githubOwner, state.githubRepo, task.branchName, changedPaths)
          : {};
        currentFiles['pr.diff'] = prDiff;
        lastFixInputDiff = prDiff;

        const fixAgent = new FixAgent();
        this._applyTaskModel(fixAgent, task);
        let fixOutput = await fixAgent.fixCode(
          task,
          blockingComments,
          currentFiles
        );

        // 見せていない既存ファイルへの書き込みは、内容を消す事故になるため除外して可視化する
        const guard = (shown: { [path: string]: string }) => guardUnshownOverwrites(
          fixOutput.files,
          Object.keys(shown),
          (p) => githubAgent.pathExistsInWorktree(state.githubOwner, state.githubRepo, task.branchName, p)
        );
        let { kept: shownFixFiles, blocked: blockedFixFiles } = await guard(currentFiles);
        if (blockedFixFiles.length > 0) {
          // 止めたファイルを直す必要がある修正もあるため、それらを見せたうえで 1 回だけ呼び直す（見ないままの上書きは防ぐ）
          const read = await this.githubAgent.readFiles(
            state.githubOwner, state.githubRepo, task.branchName, blockedFixFiles
          );
          const extra = Object.fromEntries(Object.entries(read).filter(([p]) => blockedFixFiles.includes(p)));
          if (Object.keys(extra).length > 0) {
            logger.warn(
              'FixAgent tried to overwrite existing files it was not shown; retrying once with those files shown',
              blockedFixFiles.join(', ')
            );
            const retryFiles = { ...currentFiles, ...extra };
            fixOutput = await fixAgent.fixCode(task, blockingComments, retryFiles);
            ({ kept: shownFixFiles, blocked: blockedFixFiles } = await guard(retryFiles));
          }
          if (blockedFixFiles.length > 0) {
            logger.warn(
              'FixAgent tried to overwrite existing files it was not shown; ignoring those changes',
              blockedFixFiles.join(', ')
            );
          }
        }
        // 受け入れテストは要件から独立に書いた判定基準なので、FixAgent に書き換えさせない（期待値を変えて通すのを防ぐ）
        const protectedTests = task.kind === 'acceptance' ? new Set(task.testFiles ?? []) : new Set<string>();
        const fixFiles = shownFixFiles.filter((f) => !protectedTests.has(f.path.replace(/\\/g, '/').replace(/^\.\//, '')));
        if (fixFiles.length < shownFixFiles.length) {
          logger.warn(
            'FixAgent tried to modify acceptance tests; ignoring those changes (fix the implementation instead)',
            shownFixFiles.filter((f) => !fixFiles.includes(f)).map((f) => f.path).join(', ')
          );
        }

        // Commit fixes
        const fixCommitted = fixFiles.length === 0
          ? false
          : await githubAgent.commitFiles(
              state.githubOwner,
              state.githubRepo,
              task.branchName,
              fixFiles,
              fixOutput.commitMessage
            );
        if (!fixCommitted) {
          logger.warn('FixAgent produced no file changes', task.title);
        } else {
          diffBaselineAfterFix = lastFixInputDiff;
        }

        await this.stateManager.updateTask(task.id, {
          status: 'fixing',
          errorMessage: undefined,
        });

        currentState = await this.stateManager.load();
        if (!currentState) throw new Error('Failed to load state');
        currentState.agentHistories.fix = fixAgent.getHistory();
        await this.stateManager.save(currentState);
      } else {
        // Max iterations reached
        logger.warn(
          'Max review iterations reached',
          `Task ${task.id} could not be approved`
        );

        await githubAgent.requestChanges(
          state.githubOwner,
          state.githubRepo,
          prNumber,
          [
            'Could not reach approval after maximum review iterations.',
            `Remaining blocking comments: ${blockingComments.length}`,
            combinedReviewResult.summary,
          ].join('\n\n')
        );

        throw new Error(
          `Task approval failed after ${this.maxReviewIterations} iterations`
        );
      }
    }
  }

  private async _verifyContextWorktreeSynced(state: ProjectState): Promise<void> {
    const syncInfo = await this.githubAgent.syncContextWorktree(
      state.githubOwner,
      state.githubRepo
    );
    logger.info(
      'Final context worktree verification passed',
      `${syncInfo.branch}@${syncInfo.commit.slice(0, 12)} ${syncInfo.path}`
    );
    const productSyncInfo = await this.githubAgent.syncProductWorktree(
      state.githubOwner,
      state.githubRepo
    );
    if (productSyncInfo) {
      logger.info(
        'Final product worktree verification passed',
        `${productSyncInfo.branch}@${productSyncInfo.commit.slice(0, 12)} ${productSyncInfo.path}`
      );
    }
  }

  /**
   * Issue #7: REPO_CONTEXT_SUMMARY=true のとき、リポジトリコンテキストを一度だけ要約する。
   * 要約は後続の Requirements / Design / TaskDecomp で再利用され、巨大コンテキストの
   * 重複送信を避けてトークンを削減する。無効時・空のときは元のコンテキストをそのまま返す。
   * 要約に失敗した場合は元のコンテキストにフォールバックする（品質を落とさないため）。
   */
  private async _summarizeRepoContextIfEnabled(
    repositoryContext?: string
  ): Promise<string | undefined> {
    if (!repositoryContext) return repositoryContext;
    if (process.env.REPO_CONTEXT_SUMMARY !== 'true') return repositoryContext;

    try {
      const summaryAgent = new RepoContextSummaryAgent();
      const summary = await summaryAgent.summarize(repositoryContext);
      if (!summary) {
        logger.warn('Repo context summary was empty; falling back to full context');
        return repositoryContext;
      }
      logger.info(
        'Repo context summarized for reuse',
        `${repositoryContext.length} chars -> ${summary.length} chars`
      );
      return [
        '# リポジトリコンテキスト要約',
        '(元の全文ではなく、再利用のため要約されたコンテキストです)',
        '',
        summary,
      ].join('\n');
    } catch (err) {
      if (isLlmUsageLimitError(err)) throw err;
      logger.warn('Repo context summarization failed; using full context', String(err));
      return repositoryContext;
    }
  }

  private async _runIssueOnlyPlanning(
    sourceIssues: SourceIssue[],
    instruction: string,
    owner: string,
    repo: string,
    repositoryContext?: string
  ): Promise<ProjectState> {
    logger.section('ISSUE PLANNING: CHECK EXISTING ISSUE');
    if (sourceIssues.length === 0) {
      throw new Error('No source issues selected');
    }

    const requirementsDoc = this._buildSourceIssueRequirementsDoc(sourceIssues, instruction);
    const designDoc = this._buildSourceIssueDesignDoc(sourceIssues, repositoryContext);

    await this._saveMarkdown('.ecosystem/requirements.md', requirementsDoc);
    await this.stateManager.updateRequirementsDoc(requirementsDoc);
    await this._saveMarkdown('.ecosystem/design.md', designDoc);
    await this.stateManager.updateDesignDoc(designDoc);

    const taskPlanner = new TaskDecompAgent();
    const plannedIssueTasks = await this._planSourceIssueTasks(
      sourceIssues,
      instruction,
      repositoryContext,
      taskPlanner
    );
    const tasks = plannedIssueTasks.flatMap((planned) => planned.tasks);

    for (const planned of plannedIssueTasks) {
      if (!planned.split) continue;
      await this._createIssuesForTasks(planned.tasks, owner, repo, planned.sourceIssue);
      try {
        await this._commentSourceIssueWithTasks(planned.sourceIssue, planned.tasks, owner, repo);
      } catch (err) {
        logger.warn('Failed to comment source issue with generated task list; continuing', String(err));
      }
    }

    await this.stateManager.setTasks(tasks);
    const currentState = await this.stateManager.load();
    if (!currentState) throw new Error('Failed to load state');
    currentState.agentHistories.taskDecomp = plannedIssueTasks.some((planned) => planned.split)
      ? taskPlanner.getHistory()
      : currentState.agentHistories.taskDecomp;
    await this.stateManager.save(currentState);

    logger.info('Existing issues accepted as executable tasks', {
      issueCount: sourceIssues.length,
      taskCount: tasks.length,
      splitIssueCount: plannedIssueTasks.filter((planned) => planned.split).length,
      issues: sourceIssues.map((issue) => `#${issue.number}`).join(', '),
    });

    return currentState;
  }

  private async _planSourceIssueTasks(
    sourceIssues: SourceIssue[],
    instruction: string,
    repositoryContext: string | undefined,
    taskPlanner: TaskDecompAgent
  ): Promise<PlannedIssueTasks[]> {
    const plannedIssueTasks: PlannedIssueTasks[] = [];

    for (const sourceIssue of sourceIssues) {
      const splitDecision = this._decideIssueSplit(sourceIssue);
      if (!splitDecision.shouldSplit) {
        plannedIssueTasks.push({
          sourceIssue,
          tasks: [this._createDirectIssueTask(sourceIssue)],
          split: false,
        });
        continue;
      }

      logger.info('Large source issue will be decomposed before coding', {
        issue: `#${sourceIssue.number}`,
        reasons: splitDecision.reasons,
        metrics: splitDecision.metrics,
      });

      const decomposedTasks = await taskPlanner.decomposeTask(
        this._buildSourceIssueRequirementsDoc([sourceIssue], instruction),
        this._buildSplitIssueDesignDoc(sourceIssue, repositoryContext, splitDecision)
      );
      const tasks = this._normalizeSplitIssueTasks(sourceIssue, decomposedTasks);

      if (tasks.length < 2) {
        throw new Error(
          [
            `Issue #${sourceIssue.number} was classified as too large for one coding task.`,
            `Reasons: ${splitDecision.reasons.join(', ') || 'manual split mode'}.`,
            `TaskDecompAgent returned ${tasks.length} implementable task(s); refusing to run it as a single oversized task.`,
          ].join(' ')
        );
      }

      plannedIssueTasks.push({ sourceIssue, tasks, split: true });
    }

    return plannedIssueTasks;
  }

  private _createDirectIssueTask(sourceIssue: SourceIssue): Task {
    const now = new Date().toISOString();

    return {
      id: randomUUID(),
      title: sourceIssue.title,
      summary: [
        `既存 Issue #${sourceIssue.number} を実装します。`,
        sourceIssue.body.trim() || '(Issue body is empty)',
      ].join('\n\n'),
      branchName: `feat/issue-${sourceIssue.number}-${this._slugify(sourceIssue.title)}`,
      targetFiles: this._extractIssueTargetFiles(sourceIssue.body),
      status: 'pending' as const,
      issueNumber: sourceIssue.number,
      issueUrl: sourceIssue.url,
      reviewIteration: 0,
      createdAt: now,
      updatedAt: now,
    };
  }

  private _normalizeSplitIssueTasks(
    sourceIssue: SourceIssue,
    decomposedTasks: Task[]
  ): Task[] {
    const now = new Date().toISOString();
    const issueTargetFiles = this._extractIssueTargetFiles(sourceIssue.body);

    return decomposedTasks.map((task, index) => {
      const title = (task.title || '').trim() || `Issue #${sourceIssue.number} part ${index + 1}`;
      const targetFiles = this._cleanTargetFiles(task.targetFiles);

      return {
        id: randomUUID(),
        title: `Issue #${sourceIssue.number}-${index + 1}: ${title}`,
        summary: [
          `Source issue: #${sourceIssue.number}`,
          sourceIssue.url,
          task.summary?.trim() || sourceIssue.body.trim() || '(Issue body is empty)',
        ].join('\n\n'),
        branchName: `feat/issue-${sourceIssue.number}-${String(index + 1).padStart(2, '0')}-${this._slugify(title)}`,
        targetFiles: targetFiles.length > 0 ? targetFiles : issueTargetFiles,
        complexity: task.complexity,
        status: 'pending' as const,
        reviewIteration: 0,
        createdAt: now,
        updatedAt: now,
      };
    });
  }

  private _decideIssueSplit(sourceIssue: SourceIssue): IssueSplitDecision {
    const body = sourceIssue.body || '';
    const targetFiles = this._extractIssueTargetFiles(body);
    const codeAreas = new Set(
      targetFiles
        .map((file) => file.split('/')[0])
        .filter(Boolean)
    );
    const metrics = {
      bodyChars: body.length,
      numberedItems: (body.match(/^\s*\d+[.)．]\s+/gm) || []).length,
      targetFiles: targetFiles.length,
      codeAreas: codeAreas.size,
    };
    const reasons: string[] = [];
    const mode =
      ISSUE_SPLIT_MODE === 'always' || ISSUE_SPLIT_MODE === 'never'
        ? ISSUE_SPLIT_MODE
        : 'auto';

    if (mode === 'never') {
      return { shouldSplit: false, reasons, metrics };
    }
    if (mode === 'always') {
      return {
        shouldSplit: true,
        reasons: ['ISSUE_SPLIT_MODE=always'],
        metrics,
      };
    }

    if (metrics.bodyChars >= ISSUE_SPLIT_BODY_CHARS) {
      reasons.push(`body chars ${metrics.bodyChars} >= ${ISSUE_SPLIT_BODY_CHARS}`);
    }
    if (metrics.numberedItems >= ISSUE_SPLIT_NUMBERED_ITEMS) {
      reasons.push(`numbered items ${metrics.numberedItems} >= ${ISSUE_SPLIT_NUMBERED_ITEMS}`);
    }
    if (metrics.targetFiles >= ISSUE_SPLIT_TARGET_FILES) {
      reasons.push(`target files ${metrics.targetFiles} >= ${ISSUE_SPLIT_TARGET_FILES}`);
    }
    if (metrics.codeAreas >= 2 && metrics.targetFiles >= 3) {
      reasons.push(`multiple code areas (${metrics.codeAreas}) with ${metrics.targetFiles} target files`);
    }

    return {
      shouldSplit: reasons.length > 0,
      reasons,
      metrics,
    };
  }

  private _buildSplitIssueDesignDoc(
    sourceIssue: SourceIssue,
    repositoryContext: string | undefined,
    splitDecision: IssueSplitDecision
  ): string {
    return `${this._buildSourceIssueDesignDoc([sourceIssue], repositoryContext)}

## Large Issue Decomposition Rules
- This issue must be decomposed before implementation.
- Split into 2-6 ordered tasks that can each be implemented and reviewed independently.
- Prefer separating schema/migration, backend API/service, frontend UI, export/integration, and tests.
- Keep each task near ${ISSUE_SPLIT_MAX_TARGET_FILES_PER_TASK} target files or fewer when practical.
- Include concrete targetFiles for every task.
- Do not create speculative tasks outside the source issue scope.

## Split Trigger
- ${splitDecision.reasons.join('\n- ') || 'manual split mode'}
`;
  }

  private _extractIssueTargetFiles(text: string): string[] {
    const matches = text.matchAll(
      /(?:^|[\s`'"(（])((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.*-]+\.(?:ts|tsx|js|jsx|json|prisma|sql|md|yml|yaml|css|scss|html|ps1|sh|env|example))/gm
    );
    return this._cleanTargetFiles([...matches].map((match) => match[1]));
  }

  private _cleanTargetFiles(paths: string[]): string[] {
    const cleaned = paths
      .map((path) => path.trim().replace(/\\/g, '/').replace(/[),.;:，、。]+$/g, ''))
      .filter((path) => path.length > 0 && !path.startsWith('http'));

    return [...new Set(cleaned)];
  }

  private _buildSourceIssueRequirementsDoc(sourceIssues: SourceIssue[], instruction: string): string {
    const issueSections = sourceIssues.map((sourceIssue) => {
      const labels = sourceIssue.labels.length > 0 ? sourceIssue.labels.join(', ') : 'なし';
      const body = sourceIssue.body.trim() || '(本文なし)';

      return `### Issue #${sourceIssue.number}
- Title: ${sourceIssue.title}
- URL: ${sourceIssue.url}
- Labels: ${labels}

${body}`;
    }).join('\n\n');

    return `# 既存 Issue 内容確認

## 対象 Issue
${issueSections}

## 実行判断
- 選択した既存 Issue をそれぞれ実行単位として扱う
- 追加のタスク分解 Issue は作成しない
- 実装 PR は各 Issue に紐づける

## 入力全文
${instruction}
`;
  }

  private _buildSourceIssueDesignDoc(sourceIssues: SourceIssue[], repositoryContext?: string): string {
    const targetIssues = sourceIssues
      .map((sourceIssue) => `- GitHub Issue #${sourceIssue.number}: ${sourceIssue.title}`)
      .join('\n');

    return `# 既存 Issue 実装メモ

## 実装対象
${targetIssues}

## 実装方針
- Issue 本文を受け入れ条件として扱う
- Issue ごとに独立した実行タスクとして処理する
- 既存コードを読んで、最小限の変更で Issue を解決する
- 変更後は既存の build/test チェックで検証する

## リポジトリコンテキスト
${repositoryContext || '(repository context was not loaded)'}
`;
  }

  private _slugify(value: string): string {
    const slug = value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48);

    return slug || 'task';
  }

  private getBlockingComments(reviewResult: ReviewResult): ReviewComment[] {
    return reviewResult.comments.filter(
      (comment) => comment.severity === 'blocking'
    );
  }

  private async _recordTaskCheck(
    task: Task,
    check: Omit<TaskCheckResult, 'updatedAt'>
  ): Promise<void> {
    const state = await this.stateManager.load();
    if (!state) return;

    const target = state.tasks.find((stateTask) => stateTask.id === task.id);
    if (!target) return;

    const updated: TaskCheckResult = {
      ...check,
      updatedAt: new Date().toISOString(),
    };
    target.lastChecks = [
      ...(target.lastChecks ?? []).filter((existing) => existing.name !== updated.name),
      updated,
    ];
    task.lastChecks = target.lastChecks;
    await this.stateManager.save(state);
  }

  private async _createIssuesForTasks(
    tasks: Task[],
    owner: string,
    repo: string,
    sourceIssue?: SourceIssue
  ): Promise<void> {
    for (const [index, task] of tasks.entries()) {
      logger.info('Creating GitHub issue for task...', `${index + 1}/${tasks.length}: ${task.title}`);

      const issue = await this.githubAgent.createIssue(
        owner,
        repo,
        task.title,
        [
          task.summary,
          '',
          `Task ID: ${task.id}`,
          `Branch: ${task.branchName}`,
          ...(task.complexity ? [`Complexity: ${task.complexity}`] : []),
          '',
          'Target files:',
          ...(task.targetFiles.length > 0
            ? task.targetFiles.map((file) => `- ${file}`)
            : ['- (not specified)']),
          ...(sourceIssue
            ? [
                '',
                `Source issue: #${sourceIssue.number}`,
                sourceIssue.url,
              ]
            : []),
          '',
          'This issue is managed by Auto Coding Ecosystem and will be processed in queue order.',
        ].join('\n')
      );

      task.issueNumber = issue.issueNumber;
      task.issueUrl = issue.issueUrl;
    }
  }

  private async _commentSourceIssueWithTasks(
    sourceIssue: SourceIssue,
    tasks: Task[],
    owner: string,
    repo: string
  ): Promise<void> {
    const taskLines = tasks.map((task) =>
      task.issueNumber
        ? `- #${task.issueNumber}: ${task.title}`
        : `- ${task.title}`
    );

    await this.githubAgent.commentIssue(
      owner,
      repo,
      sourceIssue.number,
      [
        'Auto Coding Ecosystem がこの Issue の処理を開始しました。',
        '',
        '生成された実行タスク:',
        ...taskLines,
      ].join('\n')
    );
  }

  private async _closeSourceIssueIfNeeded(state: ProjectState): Promise<void> {
    const sourceIssues =
      state.sourceIssues && state.sourceIssues.length > 0
        ? state.sourceIssues
        : state.sourceIssue
          ? [state.sourceIssue]
          : [];
    if (sourceIssues.length === 0) {
      return;
    }

    const taskIssueNumbers = new Set(
      state.tasks
        .map((task) => task.issueNumber)
        .filter((issueNumber): issueNumber is number => issueNumber !== undefined)
    );

    const completedTasks = state.tasks
      .filter((task) => task.issueNumber)
      .map((task) => `#${task.issueNumber}`)
      .join(', ');

    for (const sourceIssue of sourceIssues) {
      if (taskIssueNumbers.has(sourceIssue.number)) {
        continue;
      }

      await this.githubAgent.closeIssue(
        state.githubOwner,
        state.githubRepo,
        sourceIssue.number,
        [
          'Auto Coding Ecosystem による実行が完了しました。',
          completedTasks ? `完了した実行タスク: ${completedTasks}` : '',
        ].filter(Boolean).join('\n\n')
      );
    }
  }

  private async _runBuildCheck(
    githubAgent: GitHubAgent,
    state: ProjectState,
    task: Task
  ): Promise<ReviewComment[]> {
    if (process.env.BUILD_CHECK_ENABLED === 'false') {
      const body = '**決定論ゲート未実行**\n\n`BUILD_CHECK_ENABLED=false` のため、TypeScript型チェック・依存インストール・テスト・カバレッジ確認は実行されていません。';
      await this._recordTaskCheck(task, {
        name: 'build-gate',
        status: 'skipped',
        summary: 'BUILD_CHECK_ENABLED=false のため決定論ゲートを未実行',
        severity: 'suggestion',
      });
      logger.warn('Build/test gate disabled by BUILD_CHECK_ENABLED=false');
      return [{
        path: 'package.json',
        line: 1,
        body,
        severity: 'suggestion',
      }];
    }

    const comments: ReviewComment[] = [];

    // TypeScript type check
    const tsconfigFiles = await githubAgent.readFiles(
      state.githubOwner, state.githubRepo, task.branchName, ['tsconfig.json']
    );
    if (tsconfigFiles['tsconfig.json']) {
      logger.info('Running TypeScript type check...');
      const command = commandLine('npx', ['tsc', '--noEmit', '--pretty', 'false']);
      const tscResult = await githubAgent.runCommandInWorktree(
        state.githubOwner, state.githubRepo, task.branchName,
        'npx', ['tsc', '--noEmit', '--pretty', 'false'], 90000
      );

      if (tscResult.timedOut) {
        logger.warn('TypeScript type check timed out');
        await this._recordTaskCheck(task, {
          name: 'typescript',
          status: 'failed',
          summary: 'TypeScript型チェックがタイムアウト',
          command,
          timedOut: true,
          severity: 'blocking',
        });
        comments.push({
          path: 'tsconfig.json',
          line: 1,
          body: '**ビルドエラー（TypeScript型チェックタイムアウト）**\n\n`npx tsc --noEmit` がタイムアウトしました。型チェックが完了する状態にしてからマージしてください。',
          severity: 'blocking',
        });
      } else if (tscResult.exitCode !== 0 && tscResult.exitCode !== -1) {
        const errorOutput = (tscResult.stdout + '\n' + tscResult.stderr).trim();
        const lineCount = errorOutput.split('\n').length;
        logger.warn('TypeScript type check failed', `${lineCount} lines of errors`);
        await this._recordTaskCheck(task, {
          name: 'typescript',
          status: 'failed',
          summary: `TypeScript型チェック失敗（${lineCount}行の出力）`,
          command,
          exitCode: tscResult.exitCode,
          severity: 'blocking',
          details: summarizeOutput(errorOutput, 1000),
        });
        comments.push({
          path: 'tsconfig.json',
          line: 1,
          body: `**ビルドエラー（TypeScript型チェック失敗）**\n\n\`npx tsc --noEmit\` が失敗しました。型エラーをすべて修正してからマージしてください。\n\n\`\`\`\n${errorOutput.slice(0, 3000)}\n\`\`\``,
          severity: 'blocking',
        });
      } else if (tscResult.exitCode === 0) {
        logger.info('TypeScript type check passed');
        await this._recordTaskCheck(task, {
          name: 'typescript',
          status: 'passed',
          summary: 'TypeScript型チェック通過',
          command,
          exitCode: 0,
        });
      }
    } else {
      await this._recordTaskCheck(task, {
        name: 'typescript',
        status: 'skipped',
        summary: 'tsconfig.json がないためTypeScript型チェックを未実行',
      });
    }

    const pkgFiles = await githubAgent.readFiles(
      state.githubOwner,
      state.githubRepo,
      task.branchName,
      [
        'package.json',
        'package-lock.json',
        'npm-shrinkwrap.json',
        'pnpm-lock.yaml',
        'yarn.lock',
        'bun.lock',
        'bun.lockb',
      ]
    );
    if (pkgFiles['package.json']) {
      let pkg: any;
      try { pkg = JSON.parse(pkgFiles['package.json']); } catch { pkg = null; }

      const testScript: string | undefined = pkg?.scripts?.test;
      const hasRealTestScript = Boolean(
        testScript && !testScript.includes('no test specified') && !testScript.includes('exit 1')
      );

      if (hasRealTestScript) {
        const hasNodeModules = await githubAgent.pathExistsInWorktree(
          state.githubOwner, state.githubRepo, task.branchName, 'node_modules'
        );

        if (!hasNodeModules) {
          const installChoice = selectInstallCommand(pkg, {
            packageLock: Boolean(pkgFiles['package-lock.json']),
            npmShrinkwrap: Boolean(pkgFiles['npm-shrinkwrap.json']),
            pnpmLock: Boolean(pkgFiles['pnpm-lock.yaml']),
            yarnLock: Boolean(pkgFiles['yarn.lock']),
            bunLock: Boolean(pkgFiles['bun.lock'] || pkgFiles['bun.lockb']),
          });
          const installCommand = commandLine(installChoice.command, installChoice.args);
          logger.info('node_modules not found; installing dependencies before test...', installCommand);
          const installResult = await githubAgent.runCommandInWorktree(
            state.githubOwner, state.githubRepo, task.branchName,
            installChoice.command, installChoice.args, 180000
          );
          if (installResult.exitCode !== 0) {
            const errorOutput = (installResult.stdout + '\n' + installResult.stderr).trim();
            logger.warn('npm install failed; blocking test execution');
            await this._recordTaskCheck(task, {
              name: 'install',
              status: 'failed',
              summary: `依存インストール失敗: ${installCommand}`,
              command: installCommand,
              exitCode: installResult.exitCode,
              timedOut: installResult.timedOut,
              severity: 'blocking',
              details: summarizeOutput(errorOutput, 1000),
            });
            comments.push({
              path: 'package.json',
              line: 1,
              body: `**テスト準備失敗**\n\n\`${installCommand}\` が失敗したため、\`npm test\` を実行できませんでした。\n\n理由: ${installChoice.reason}\n\n依存関係の問題を修正してからマージしてください。\n\n\`\`\`\n${errorOutput.slice(0, 3000)}\n\`\`\``,
              severity: 'blocking',
            });
            await this._recordTaskCheck(task, {
              name: 'build-gate',
              status: 'failed',
              summary: '依存インストール失敗により決定論ゲート停止',
              severity: 'blocking',
            });
            return comments;
          }
          await this._recordTaskCheck(task, {
            name: 'install',
            status: 'passed',
            summary: `依存インストール通過: ${installCommand}`,
            command: installCommand,
            exitCode: 0,
            details: installChoice.reason,
          });
        } else {
          await this._recordTaskCheck(task, {
            name: 'install',
            status: 'skipped',
            summary: 'node_modules が存在するため依存インストールを未実行',
          });
        }

        logger.info('Running npm test...');
        const testCommand = commandLine('npm', ['test']);
        const testResult = await githubAgent.runCommandInWorktree(
          state.githubOwner, state.githubRepo, task.branchName,
          'npm', ['test'], 120000
        );

        if (testResult.timedOut) {
          logger.warn('npm test timed out');
          await this._recordTaskCheck(task, {
            name: 'test',
            status: 'failed',
            summary: 'npm test がタイムアウト',
            command: testCommand,
            timedOut: true,
            severity: 'blocking',
          });
          comments.push({
            path: 'package.json',
            line: 1,
            body: '**テスト失敗（タイムアウト）**\n\n`npm test` がタイムアウトしました。テストが完了する状態にしてからマージしてください。',
            severity: 'blocking',
          });
        } else if (testResult.exitCode !== 0) {
          const errorOutput = (testResult.stdout + '\n' + testResult.stderr).trim();
          const failureSummary = parseTestOutput(errorOutput);
          logger.warn('npm test failed', `exit code: ${testResult.exitCode}, failed: ${failureSummary.totalFailed}`);
          await this._recordTaskCheck(task, {
            name: 'test',
            status: 'failed',
            summary: `npm test 失敗（${failureSummary.totalFailed}件）`,
            command: testCommand,
            exitCode: testResult.exitCode,
            severity: 'blocking',
            details: summarizeOutput(formatTestFailureComment(failureSummary, errorOutput), 1500),
          });
          comments.push({
            path: 'package.json',
            line: 1,
            body: `**テスト失敗**\n\n\`npm test\` が失敗しました。マージ前にすべてのテストを通してください。\n\n${formatTestFailureComment(failureSummary, errorOutput)}`,
            severity: 'blocking',
          });
        } else {
          logger.info('npm test passed');
          await this._recordTaskCheck(task, {
            name: 'test',
            status: 'passed',
            summary: 'npm test 通過',
            command: testCommand,
            exitCode: 0,
          });
        }

        // test script が一部のテストしか実行しない場合、npm test の通過は他のテストの健全性を保証しない
        const lsResult = await githubAgent.runCommandInWorktree(
          state.githubOwner, state.githubRepo, task.branchName,
          'git', ['ls-files'], 30000
        );
        const testFilesInRepo = (lsResult?.stdout ?? '')
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(l));
        const unexecuted = findUnexecutedTestFiles(testScript as string, testFilesInRepo);
        if (unexecuted.length > 0) {
          logger.warn('test script does not run all test files', unexecuted.join(', '));
          await this._recordTaskCheck(task, {
            name: 'test-coverage-of-script',
            status: 'failed',
            summary: `test script が ${unexecuted.length} 件のテストファイルを実行しない`,
            severity: 'blocking',
            details: unexecuted.join('\n'),
          });
          comments.push({
            path: 'package.json',
            line: 1,
            body: `**test script が全テストを実行していません**\n\n\`scripts.test\` (\`${testScript}\`) は次のテストファイルを実行しないため、\`npm test\` が通っても、それらの健全性が保証されません。\`scripts.test\` を、すべてのテストを実行するよう直してください（例: \`node --test\` にファイル引数を付けない、またはすべて列挙する）。\n\n**以下のファイルはすでにリポジトリに存在します。作り直さず、内容も変更せず、\`package.json\` の \`scripts.test\` だけを直してください。**\n\n${unexecuted.map((f) => `- ${f}`).join('\n')}`,
            severity: 'blocking',
          });
        } else {
          await this._recordTaskCheck(task, {
            name: 'test-coverage-of-script',
            status: 'passed',
            summary: `test script は ${testFilesInRepo.length} 件のテストファイルをすべて実行対象にしている（または判定対象外）`,
          });
        }
      } else {
        await this._runNodeTestFallback(githubAgent, state, task, comments, '有効な test script がない');
      }
    } else {
      await this._recordTaskCheck(task, {
        name: 'install',
        status: 'skipped',
        summary: 'package.json がないため依存インストールを未実行',
      });
      await this._runNodeTestFallback(githubAgent, state, task, comments, 'package.json がない');
    }

    // 起動確認（受け入れタスクのみ）: テストとは独立に、実際に起動して GET / が応答するかを確かめる。
    // 各タスクでは行わない（初期のタスクでは / がまだ無く、誤ってブロックするため）。
    if (task.kind === 'acceptance') {
      let startScript: string | undefined;
      try { startScript = JSON.parse(pkgFiles['package.json'] ?? '{}')?.scripts?.start; } catch { startScript = undefined; }
      if (!startScript) {
        await this._recordTaskCheck(task, {
          name: 'smoke',
          status: 'skipped',
          summary: 'package.json に start script がないため起動確認を未実行',
        });
      } else {
        logger.info('Running smoke check (npm start + GET /)...');
        const smoke = await githubAgent.runSmokeCheckInWorktree(state.githubOwner, state.githubRepo, task.branchName);
        await this._recordTaskCheck(task, {
          name: 'smoke',
          status: smoke.status,
          summary: smoke.summary,
          command: commandLine('npm', ['start']),
          severity: smoke.status === 'failed' ? 'blocking' : undefined,
          details: smoke.details ? summarizeOutput(smoke.details, 1500) : undefined,
        });
        if (smoke.status === 'failed') {
          logger.warn('Smoke check failed', smoke.summary);
          comments.push({
            path: entryFileFromStartScript(startScript) ?? 'package.json',
            line: 1,
            body: `**起動確認失敗**\n\n${smoke.summary}\n\nアプリを \`npm start\`（環境変数 PORT で待ち受け）で起動し、\`GET /\` が 2xx/3xx を返すように実装を直してください。\n\n\`\`\`\n${(smoke.details ?? '').slice(0, 2000)}\n\`\`\``,
            severity: 'blocking',
          });
        } else {
          logger.info('Smoke check', smoke.summary);
        }
      }
    }

    // Coverage check (opt-in via COVERAGE_CHECK_ENABLED=true)
    if (process.env.COVERAGE_CHECK_ENABLED === 'true') {
      const coveragePkg = pkgFiles?.['package.json']
        ? (() => { try { return JSON.parse(pkgFiles['package.json']); } catch { return null; } })()
        : null;
      const coverageScript: string | undefined = coveragePkg?.scripts?.['test:coverage'];
      const coverageStrict = process.env.COVERAGE_CHECK_STRICT === 'true';
      const coverageSeverity: ReviewComment['severity'] = coverageStrict ? 'blocking' : 'suggestion';
      if (coverageScript) {
        const lineThreshold = Number(process.env.COVERAGE_LINE_THRESHOLD ?? '70');
        const branchThreshold = Number(process.env.COVERAGE_BRANCH_THRESHOLD ?? '60');
        logger.info('Running coverage check...');
        const coverageCommand = commandLine('npm', ['run', 'test:coverage']);
        const coverageResult = await githubAgent.runCommandInWorktree(
          state.githubOwner, state.githubRepo, task.branchName,
          'npm', ['run', 'test:coverage'], 180000
        );
        const coverageOutput = (coverageResult.stdout + '\n' + coverageResult.stderr).trim();
        if (coverageResult.timedOut || coverageResult.exitCode !== 0) {
          const body = [
            coverageResult.timedOut ? '**カバレッジ計測失敗（タイムアウト）**' : '**カバレッジ計測失敗**',
            '',
            `\`${coverageCommand}\` を実行しましたが、カバレッジを計測できませんでした。`,
            '',
            '```',
            coverageOutput.slice(0, 3000),
            '```',
          ].join('\n');
          await this._recordTaskCheck(task, {
            name: 'coverage',
            status: coverageStrict ? 'failed' : 'warning',
            summary: coverageResult.timedOut ? 'カバレッジ計測がタイムアウト' : `カバレッジ計測失敗（exit ${coverageResult.exitCode}）`,
            command: coverageCommand,
            exitCode: coverageResult.exitCode,
            timedOut: coverageResult.timedOut,
            severity: coverageSeverity,
            details: summarizeOutput(coverageOutput, 1000),
          });
          comments.push({ path: 'package.json', line: 1, body, severity: coverageSeverity });
        } else {
          const summary = parseCoverageOutput(coverageOutput);
          if (summary) {
          const lineOk = summary.lines >= lineThreshold;
          const branchOk = summary.branches >= branchThreshold;
          if (!lineOk || !branchOk) {
            logger.warn('Coverage below threshold', `lines: ${summary.lines}%, branches: ${summary.branches}%`);
            await this._recordTaskCheck(task, {
              name: 'coverage',
              status: 'warning',
              summary: `カバレッジ閾値未満 lines ${summary.lines}% / branches ${summary.branches}%`,
              command: coverageCommand,
              exitCode: 0,
              severity: 'suggestion',
            });
            comments.push({
              path: 'package.json',
              line: 1,
              body: formatCoverageComment(summary, lineThreshold, branchThreshold),
              severity: 'suggestion',
            });
          } else {
            logger.info('Coverage check passed', `lines: ${summary.lines}%, branches: ${summary.branches}%`);
            await this._recordTaskCheck(task, {
              name: 'coverage',
              status: 'passed',
              summary: `カバレッジ閾値クリア lines ${summary.lines}% / branches ${summary.branches}%`,
              command: coverageCommand,
              exitCode: 0,
            });
          }
        } else {
          logger.warn('Could not parse coverage output');
          const body = [
            '**カバレッジ未解析**',
            '',
            `\`${coverageCommand}\` は成功しましたが、出力からカバレッジ率を解析できませんでした。`,
            '',
            '```',
            coverageOutput.slice(0, 3000),
            '```',
          ].join('\n');
          await this._recordTaskCheck(task, {
            name: 'coverage',
            status: coverageStrict ? 'failed' : 'warning',
            summary: 'カバレッジ出力を解析できませんでした',
            command: coverageCommand,
            exitCode: 0,
            severity: coverageSeverity,
            details: summarizeOutput(coverageOutput, 1000),
          });
          comments.push({ path: 'package.json', line: 1, body, severity: coverageSeverity });
          }
        }
      } else {
        logger.warn('COVERAGE_CHECK_ENABLED=true but no test:coverage script found');
        const body = '**カバレッジ未計測**\n\n`COVERAGE_CHECK_ENABLED=true` ですが、`package.json` に `test:coverage` スクリプトがないため計測できませんでした。';
        await this._recordTaskCheck(task, {
          name: 'coverage',
          status: coverageStrict ? 'failed' : 'warning',
          summary: 'test:coverage script がないためカバレッジ未計測',
          severity: coverageSeverity,
        });
        comments.push({ path: 'package.json', line: 1, body, severity: coverageSeverity });
      }
    } else {
      await this._recordTaskCheck(task, {
        name: 'coverage',
        status: 'skipped',
        summary: 'COVERAGE_CHECK_ENABLED=true ではないためカバレッジ未実行',
      });
    }

    const hasBlocking = comments.some((comment) => comment.severity === 'blocking');
    await this._recordTaskCheck(task, {
      name: 'build-gate',
      status: hasBlocking ? 'failed' : comments.length > 0 ? 'warning' : 'passed',
      summary: hasBlocking
        ? '決定論ゲートにblocking指摘があります'
        : comments.length > 0
          ? '決定論ゲートは完了しましたがsuggestionがあります'
          : '決定論ゲート通過',
      severity: hasBlocking ? 'blocking' : comments.length > 0 ? 'suggestion' : undefined,
    });

    return comments;
  }

  private getSuggestionComments(reviewResult: ReviewResult): ReviewComment[] {
    return reviewResult.comments.filter(
      (comment) => comment.severity === 'suggestion'
    );
  }

  private _detectTestDeletion(diff: string): ReviewComment[] {
    const comments: ReviewComment[] = [];
    const lines = diff.split('\n');
    let currentFile = '';
    const reportedSkip = new Set<string>();
    const netRemovedTestCases = new Map<string, number>();
    const netRemovedExpectations = new Map<string, number>();
    const reportedWeakenedAssertion = new Set<string>();

    for (const line of lines) {
      const diffHeader = line.match(/^diff --git a\/.+ b\/(.+)$/);
      if (diffHeader) {
        currentFile = diffHeader[1];
      }

      if (
        line.startsWith('deleted file mode') &&
        currentFile &&
        /\.(test|spec)\.[jt]sx?$/.test(currentFile)
      ) {
        comments.push({
          path: currentFile,
          line: 1,
          body: `**テスト削除禁止**\n\nテストファイル \`${currentFile}\` が削除されています。テストを削除してビルドを通過させることは禁止されています。実装を修正してテストを通してください。`,
          severity: 'blocking',
        });
      }

      if (
        currentFile &&
        /\.(test|spec)\.[jt]sx?$/.test(currentFile) &&
        line.startsWith('+') &&
        !line.startsWith('+++') &&
        // テストランナーの it/test/describe/suite の .skip/.todo のみ対象（変数名 todo/skip は対象外）
        (/\b(?:it|test|describe|suite)\.(?:skip|todo)\b/.test(line) || /\b(?:xit|xtest)\s*\(/.test(line)) &&
        !reportedSkip.has(currentFile)
      ) {
        reportedSkip.add(currentFile);
        comments.push({
          path: currentFile,
          line: 1,
          body: `**テスト無効化禁止**\n\n\`${currentFile}\` に \`.skip\` / \`.todo\` / \`xit\` / \`xtest\` のいずれかが追加されています。テストを無効化してビルドを通過させることは禁止されています。`,
          severity: 'blocking',
        });
      }

      // テストケース・アサーションは、ファイル単位で「消えた数 − 増えた数」を数え、純減だけを止める。
      // 同じテストファイルを複数タスクで育てる場合、古い挙動のテストの書き換えや残骸行の削除は正当なため。
      if (currentFile && /\.(test|spec)\.[jt]sx?$/.test(currentFile)) {
        const sign = line.startsWith('-') && !line.startsWith('---') ? 1
          : line.startsWith('+') && !line.startsWith('+++') ? -1
          : 0;
        if (sign !== 0) {
          if (/\b(?:it|test)\s*\(/.test(line)) {
            netRemovedTestCases.set(currentFile, (netRemovedTestCases.get(currentFile) ?? 0) + sign);
          }
          if (/\bexpect\s*\(/.test(line)) {
            netRemovedExpectations.set(currentFile, (netRemovedExpectations.get(currentFile) ?? 0) + sign);
          }
        }
      }

      if (
        currentFile &&
        /\.(test|spec)\.[jt]sx?$/.test(currentFile) &&
        line.startsWith('+') &&
        !line.startsWith('+++') &&
        /\.(?:toBeDefined|toBeTruthy|toBeFalsy)\s*\(\s*\)/.test(line) &&
        !reportedWeakenedAssertion.has(currentFile)
      ) {
        reportedWeakenedAssertion.add(currentFile);
        comments.push({
          path: currentFile,
          line: 1,
          body: `**アサーション弱体化禁止**\n\n\`${currentFile}\` で弱いアサーションへの変更が検出されました。期待値を弱めてビルドを通過させることは禁止されています。`,
          severity: 'blocking',
        });
      }
    }

    for (const [file, net] of netRemovedTestCases) {
      if (net <= 0) continue;
      comments.push({
        path: file,
        line: 1,
        body: `**テストケース削除禁止**\n\n\`${file}\` で \`it(...)\` / \`test(...)\` が差し引き ${net} 件減っています。テスト数を減らしてビルドを通過させることは禁止されています。古い挙動のテストは、削除ではなく新しい挙動のテストに書き換えてください。`,
        severity: 'blocking',
      });
    }
    for (const [file, net] of netRemovedExpectations) {
      if (net <= 0) continue;
      comments.push({
        path: file,
        line: 1,
        body: `**アサーション削除禁止**\n\n\`${file}\` で \`expect(...)\` が差し引き ${net} 件減っています。アサーションを削除してビルドを通過させることは禁止されています。`,
        severity: 'blocking',
      });
    }

    return comments;
  }

  private async _requirementsWithValidation(
    reqAgent: RequirementsAgent,
    instruction: string,
    repositoryContext?: string
  ): Promise<string> {
    const validationAgent = new RequirementsValidationAgent();
    let doc = await reqAgent.generateRequirements(instruction, repositoryContext);

    for (let iter = 1; iter <= VALIDATION_MAX_ITERATIONS; iter++) {
      await this._saveMarkdown('.ecosystem/requirements.md', doc);

      const validation = await validationAgent.validate(doc, instruction);
      const reportMd = this._buildValidationMarkdown(
        `要件妥当性検証レポート（試行 ${iter}/${VALIDATION_MAX_ITERATIONS}）`,
        validation
      );
      await this._saveMarkdown('.ecosystem/requirements-validation.md', reportMd);

      logger.info(
        `要件妥当性スコア（試行${iter}）: ${validation.score}点 (${validation.grade})`,
        validation.summary
      );

      if (validation.score >= VALIDATION_PASS_THRESHOLD) {
        logger.info(`要件定義が閾値（${VALIDATION_PASS_THRESHOLD}点）を満たしました`);
        break;
      }

      if (iter === VALIDATION_MAX_ITERATIONS) {
        logger.warn(
          `最大試行回数（${VALIDATION_MAX_ITERATIONS}回）に達しました。最終スコア: ${validation.score}点`,
          '現在の要件定義でフェーズを続行します'
        );
        break;
      }

      logger.warn(
        `スコア ${validation.score}点 < 閾値 ${VALIDATION_PASS_THRESHOLD}点 — 要件定義を修正します（試行${iter + 1}/${VALIDATION_MAX_ITERATIONS}）`,
        `問題点: ${validation.issues.join(' / ')}`
      );
      doc = await reqAgent.reviseRequirements(
        doc,
        validation.issues,
        validation.recommendations,
        instruction
      );
    }

    return doc;
  }

  private async _designWithValidation(
    designAgent: DesignAgent,
    requirementsDoc: string,
    repositoryContext?: string
  ): Promise<string> {
    const validationAgent = new DesignValidationAgent();
    let doc = await designAgent.generateDesign(requirementsDoc, repositoryContext);

    for (let iter = 1; iter <= VALIDATION_MAX_ITERATIONS; iter++) {
      await this._saveMarkdown('.ecosystem/design.md', doc);

      const validation = await validationAgent.validate(doc, requirementsDoc);
      const reportMd = this._buildValidationMarkdown(
        `設計書妥当性検証レポート（試行 ${iter}/${VALIDATION_MAX_ITERATIONS}）`,
        validation
      );
      await this._saveMarkdown('.ecosystem/design-validation.md', reportMd);

      logger.info(
        `設計書妥当性スコア（試行${iter}）: ${validation.score}点 (${validation.grade})`,
        validation.summary
      );

      if (validation.score >= VALIDATION_PASS_THRESHOLD) {
        logger.info(`設計書が閾値（${VALIDATION_PASS_THRESHOLD}点）を満たしました`);
        break;
      }

      if (iter === VALIDATION_MAX_ITERATIONS) {
        logger.warn(
          `最大試行回数（${VALIDATION_MAX_ITERATIONS}回）に達しました。最終スコア: ${validation.score}点`,
          '現在の設計書でフェーズを続行します'
        );
        break;
      }

      logger.warn(
        `スコア ${validation.score}点 < 閾値 ${VALIDATION_PASS_THRESHOLD}点 — 設計書を修正します（試行${iter + 1}/${VALIDATION_MAX_ITERATIONS}）`,
        `問題点: ${validation.issues.join(' / ')}`
      );
      doc = await designAgent.reviseDesign(
        doc,
        validation.issues,
        validation.recommendations,
        requirementsDoc
      );
    }

    return doc;
  }

  private async _saveMarkdown(relativePath: string, content: string): Promise<void> {
    try {
      const absPath = `${process.cwd()}/${relativePath}`;
      await fs.mkdir(dirname(absPath), { recursive: true });
      await fs.writeFile(absPath, content, 'utf-8');
      logger.info(`Markdown保存: ${relativePath}`);
    } catch (err) {
      logger.warn(`Markdown保存失敗: ${relativePath}`, String(err));
    }
  }

  private _buildValidationMarkdown(title: string, result: { score: number; grade: string; summary: string; issues: string[]; recommendations: string[]; categories: Record<string, { score: number; comment: string }> }): string {
    const categoryLines = Object.entries(result.categories)
      .map(([key, val]) => `| ${key} | ${val.score} | ${val.comment} |`)
      .join('\n');

    const issueLines = result.issues.map((i) => `- ${i}`).join('\n') || '- なし';
    const recLines = result.recommendations.map((r) => `- ${r}`).join('\n') || '- なし';

    return `# ${title}

## 総合スコア: ${result.score}点 / 100点（グレード: ${result.grade}）

## 総評
${result.summary}

## 評価カテゴリ別スコア
| カテゴリ | スコア | コメント |
|---|---|---|
${categoryLines}

## 問題点
${issueLines}

## 改善提案
${recLines}
`;
  }

  private async _runCodexReviewIfEnabled(
    task: Task,
    prDiff: string,
    state: ProjectState,
    primaryReview: Awaited<ReturnType<ReviewAgent['reviewPr']>>
  ) {
    const codexReviewEnabled = process.env.CODEX_REVIEW_ENABLED === 'true';
    if (!codexReviewEnabled) {
      return primaryReview;
    }

    try {
      const codexAgent = new CodexAgent();
      const codexReview = await codexAgent.reviewPr(
        task,
        prDiff,
        state.requirementsDoc,
        state.designDoc
      );

      // Approval: primary reviewer decides; Codex only adds extra blocking comments
      // Using AND caused both reviewers to independently block, making merges near-impossible
      const mergedComments = [...primaryReview.comments, ...codexReview.comments];
      const hasBlockingFromEither = mergedComments.some(c => c.severity === 'blocking');
      return {
        approved: primaryReview.approved && !hasBlockingFromEither,
        comments: mergedComments,
        summary: [
          `Primary review: ${primaryReview.summary}`,
          `Codex review: ${codexReview.summary}`,
        ].join('\n\n'),
      };
    } catch (err) {
      if (isLlmUsageLimitError(err)) {
        throw err;
      }

      logger.warn('Codex review failed, continuing with primary review', String(err));
      return primaryReview;
    }
  }
}
