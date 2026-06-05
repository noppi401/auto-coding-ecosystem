import { promises as fs } from 'fs';
import { randomUUID } from 'crypto';
import { dirname } from 'path';
import { StateManager } from './state/manager.js';
import { ProjectState, ReviewComment, ReviewResult, SourceIssue, Task } from './state/types.js';
import { logger } from './utils/logger.js';
import { RequirementsAgent } from './agents/requirements-agent.js';
import { RequirementsValidationAgent } from './agents/requirements-validation-agent.js';
import { DesignAgent } from './agents/design-agent.js';
import { DesignValidationAgent } from './agents/design-validation-agent.js';
import { TaskDecompAgent } from './agents/task-decomp-agent.js';
import { CodingAgent } from './agents/coding-agent.js';
import { CodexAgent } from './agents/codex-agent.js';
import { ReviewAgent } from './agents/review-agent.js';
import { FixAgent } from './agents/fix-agent.js';
import { GitHubAgent } from './agents/github-agent.js';
import { isLlmUsageLimitError } from './utils/llm-errors.js';
import { resolveTaskModel } from './utils/model-routing.js';

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

    if (sourceIssues.length > 0) {
      return await this._runIssueOnlyPlanning(
        sourceIssues,
        instruction,
        owner,
        repo,
        repositoryContext
      );
    }

    // Phase 1a+1b: Requirements Generation + Validation Loop
    logger.section('Step 1-2/5: Requirements Generation + Validation');
    const reqAgent = new RequirementsAgent();
    const requirementsDoc = await this._requirementsWithValidation(
      reqAgent,
      instruction,
      repositoryContext
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
      repositoryContext
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

    if (remainingFailedCount > 0 || remainingUnmergedCount > 0) {
      logger.warn(
        'PHASE 2 paused with remaining tasks',
        `${remainingFailedCount}/${state.tasks.length} tasks failed, ${remainingUnmergedCount}/${state.tasks.length} not merged`
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
    const currentTargetFiles =
      state.projectMode === 'modify'
        ? await githubAgent.readFiles(
            state.githubOwner,
            state.githubRepo,
            task.branchName,
            task.targetFiles
          )
        : {};

    // Generate code
    logger.info(
      'Generating code with implementation LLM...',
      process.env.IMPLEMENTATION_LLM_PROVIDER || 'claude'
    );
    const codingAgent = new CodingAgent();
    this._applyTaskModel(codingAgent, task);
    const codeOutput = await codingAgent.generateCode(
      task,
      state.requirementsDoc,
      state.designDoc,
      currentTargetFiles
    );

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

    while (iteration < this.maxReviewIterations) {
      iteration++;
      logger.info(
        `Review iteration ${iteration}/${this.maxReviewIterations}...`
      );

      // Get PR info
      const prDiff = await this.githubAgent.getPrDiff(
        state.githubOwner,
        state.githubRepo,
        prNumber
      );
      const diffUnchangedAfterFix =
        iteration > 1 && lastFixInputDiff === prDiff;

      // Build / test check (deterministic, runs before LLM review)
      const buildComments = await this._runBuildCheck(githubAgent, state, task);

      // Review
      const reviewResult =
        iteration === 1
          ? await reviewAgent.reviewPr(
              task,
              prDiff,
              state.requirementsDoc,
              state.designDoc
            )
          : await reviewAgent.reReviewAfterFix(task, prDiff);

      const combinedReviewResult = await this._runCodexReviewIfEnabled(
        task,
        prDiff,
        state,
        reviewResult
      );

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
        const changedPaths = [...new Set(
          [...prDiff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map(m => m[1])
        )];
        const currentFiles: { [path: string]: string } = changedPaths.length > 0
          ? await this.githubAgent.readFiles(state.githubOwner, state.githubRepo, task.branchName, changedPaths)
          : {};
        currentFiles['pr.diff'] = prDiff;
        lastFixInputDiff = prDiff;

        const fixAgent = new FixAgent();
        this._applyTaskModel(fixAgent, task);
        const fixOutput = await fixAgent.fixCode(
          task,
          blockingComments,
          currentFiles
        );

        // Commit fixes
        const fixCommitted = await githubAgent.commitFiles(
          state.githubOwner,
          state.githubRepo,
          task.branchName,
          fixOutput.files,
          fixOutput.commitMessage
        );
        if (!fixCommitted) {
          logger.warn('FixAgent produced no file changes', task.title);
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
      return [];
    }

    const comments: ReviewComment[] = [];

    // TypeScript type check
    const tsconfigFiles = await githubAgent.readFiles(
      state.githubOwner, state.githubRepo, task.branchName, ['tsconfig.json']
    );
    if (tsconfigFiles['tsconfig.json']) {
      logger.info('Running TypeScript type check...');
      const tscResult = await githubAgent.runCommandInWorktree(
        state.githubOwner, state.githubRepo, task.branchName,
        'npx', ['tsc', '--noEmit', '--pretty', 'false'], 90000
      );

      if (tscResult.timedOut) {
        logger.warn('TypeScript type check timed out');
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
        comments.push({
          path: 'tsconfig.json',
          line: 1,
          body: `**ビルドエラー（TypeScript型チェック失敗）**\n\n\`npx tsc --noEmit\` が失敗しました。型エラーをすべて修正してからマージしてください。\n\n\`\`\`\n${errorOutput.slice(0, 3000)}\n\`\`\``,
          severity: 'blocking',
        });
      } else if (tscResult.exitCode === 0) {
        logger.info('TypeScript type check passed');
      }
    }

    // npm test (only if node_modules is present)
    const pkgFiles = await githubAgent.readFiles(
      state.githubOwner, state.githubRepo, task.branchName, ['package.json']
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
          logger.info('node_modules not found; running npm install before test...');
          const installResult = await githubAgent.runCommandInWorktree(
            state.githubOwner, state.githubRepo, task.branchName,
            'npm', ['install', '--no-package-lock'], 180000
          );
          if (installResult.exitCode !== 0) {
            const errorOutput = (installResult.stdout + '\n' + installResult.stderr).trim();
            logger.warn('npm install failed; blocking test execution');
            comments.push({
              path: 'package.json',
              line: 1,
              body: `**テスト準備失敗**\n\n\`npm install --no-package-lock\` が失敗したため、\`npm test\` を実行できませんでした。依存関係の問題を修正してからマージしてください。\n\n\`\`\`\n${errorOutput.slice(0, 3000)}\n\`\`\``,
              severity: 'blocking',
            });
            return comments;
          }
        }

        logger.info('Running npm test...');
        const testResult = await githubAgent.runCommandInWorktree(
          state.githubOwner, state.githubRepo, task.branchName,
          'npm', ['test'], 120000
        );

        if (testResult.timedOut) {
          logger.warn('npm test timed out');
          comments.push({
            path: 'package.json',
            line: 1,
            body: '**テスト失敗（タイムアウト）**\n\n`npm test` がタイムアウトしました。テストが完了する状態にしてからマージしてください。',
            severity: 'blocking',
          });
        } else if (testResult.exitCode !== 0) {
          const errorOutput = (testResult.stdout + '\n' + testResult.stderr).trim();
          logger.warn('npm test failed', `exit code: ${testResult.exitCode}`);
          comments.push({
            path: 'package.json',
            line: 1,
            body: `**テスト失敗**\n\n\`npm test\` が失敗しました。マージ前にすべてのテストを通してください。\n\n\`\`\`\n${errorOutput.slice(0, 3000)}\n\`\`\``,
            severity: 'blocking',
          });
        } else {
          logger.info('npm test passed');
        }
      }
    }

    return comments;
  }

  private getSuggestionComments(reviewResult: ReviewResult): ReviewComment[] {
    return reviewResult.comments.filter(
      (comment) => comment.severity === 'suggestion'
    );
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
