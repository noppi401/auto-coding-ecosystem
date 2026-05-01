import { StateManager } from './state/manager.js';
import { ProjectState, ReviewComment, ReviewResult, Task } from './state/types.js';
import { logger } from './utils/logger.js';
import { RequirementsAgent } from './agents/requirements-agent.js';
import { DesignAgent } from './agents/design-agent.js';
import { TaskDecompAgent } from './agents/task-decomp-agent.js';
import { CodingAgent } from './agents/coding-agent.js';
import { CodexAgent } from './agents/codex-agent.js';
import { ReviewAgent } from './agents/review-agent.js';
import { FixAgent } from './agents/fix-agent.js';
import { GitHubAgent } from './agents/github-agent.js';
import { isLlmUsageLimitError } from './utils/llm-errors.js';

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
    } = {}
  ): Promise<ProjectState> {
    logger.section('PHASE 1: REQUIREMENTS → DESIGN → TASKS');

    const projectMode = options.projectMode || 'new';
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

    // Phase 1a: Requirements
    logger.section('Step 1/3: Requirements Generation');
    const reqAgent = new RequirementsAgent();
    const requirementsDoc = await reqAgent.generateRequirements(
      instruction,
      repositoryContext
    );

    await this.stateManager.updateRequirementsDoc(requirementsDoc);
    let currentState = await this.stateManager.load();
    if (!currentState) throw new Error('Failed to load state');
    currentState.agentHistories.requirements = reqAgent.getHistory();
    await this.stateManager.save(currentState);

    // Phase 1b: Design
    logger.section('Step 2/3: Design Generation');
    const designAgent = new DesignAgent();
    const designDoc = await designAgent.generateDesign(requirementsDoc, repositoryContext);

    await this.stateManager.updateDesignDoc(designDoc);
    currentState = await this.stateManager.load();
    if (!currentState) throw new Error('Failed to load state');
    currentState.agentHistories.design = designAgent.getHistory();
    await this.stateManager.save(currentState);

    // Phase 1c: Task Decomposition
    logger.section('Step 3/3: Task Decomposition');
    const taskAgent = new TaskDecompAgent();
    const tasks = await taskAgent.decomposeTask(
      requirementsDoc,
      designDoc
    );

    logger.section('Step 3/3: GitHub Issue Registration');
    await this._createIssuesForTasks(tasks, owner, repo);

    await this.stateManager.setTasks(tasks);
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

    await this.stateManager.markCompleted();
    logger.section('PHASE 2 COMPLETE - ALL TASKS DONE');
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
      throw new Error('CodingAgent produced no file changes to commit');
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

    if (task.issueNumber) {
      await githubAgent.commentIssue(
        state.githubOwner,
        state.githubRepo,
        task.issueNumber,
        `Implementation PR opened: #${prInfo.prNumber}\n\n${prInfo.prUrl}`
      );
    }

    await this.stateManager.updateTask(task.id, {
      status: 'pr_open',
      prNumber: prInfo.prNumber,
      prUrl: prInfo.prUrl,
      errorMessage: undefined,
    });

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

      // Convert diff to files array format for review agent
      const prFiles: Array<{ filename: string; changes: number; patch: string }> = [
        { filename: 'pull_request.diff', changes: 1, patch: prDiff }
      ];

      // Review
      const reviewResult =
        iteration === 1
          ? await reviewAgent.reviewPr(
              task,
              prDiff,
              prFiles,
              state.requirementsDoc,
              state.designDoc
            )
          : await reviewAgent.reReviewAfterFix(
              task,
              prDiff,
              prFiles,
              state.requirementsDoc,
              state.designDoc
            );

      const combinedReviewResult = await this._runCodexReviewIfEnabled(
        task,
        prDiff,
        state,
        reviewResult
      );
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

        const currentFiles: { [path: string]: string } = {};
        currentFiles['pr.diff'] = prDiff;
        lastFixInputDiff = prDiff;

        const fixAgent = new FixAgent();
        const fixOutput = await fixAgent.fixCode(
          task,
          blockingComments,
          currentFiles,
          state.requirementsDoc,
          state.designDoc
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

  private getBlockingComments(reviewResult: ReviewResult): ReviewComment[] {
    return reviewResult.comments.filter(
      (comment) => comment.severity === 'blocking'
    );
  }

  private async _createIssuesForTasks(
    tasks: Task[],
    owner: string,
    repo: string
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
          '',
          'Target files:',
          ...(task.targetFiles.length > 0
            ? task.targetFiles.map((file) => `- ${file}`)
            : ['- (not specified)']),
          '',
          'This issue is managed by Auto Coding Ecosystem and will be processed in queue order.',
        ].join('\n')
      );

      task.issueNumber = issue.issueNumber;
      task.issueUrl = issue.issueUrl;
    }
  }

  private getSuggestionComments(reviewResult: ReviewResult): ReviewComment[] {
    return reviewResult.comments.filter(
      (comment) => comment.severity === 'suggestion'
    );
  }

  private async _runCodexReviewIfEnabled(
    task: Task,
    prDiff: string,
    state: ProjectState,
    primaryReview: Awaited<ReturnType<ReviewAgent['reviewPr']>>
  ) {
    const codexReviewEnabled = process.env.CODEX_REVIEW_ENABLED !== 'false';
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

      return {
        approved: primaryReview.approved && codexReview.approved,
        comments: [...primaryReview.comments, ...codexReview.comments],
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
