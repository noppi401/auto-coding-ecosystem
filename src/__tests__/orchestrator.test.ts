import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import type { Task, ProjectState } from '../state/types.js';

vi.mock('../utils/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), section: vi.fn() },
}));

vi.mock('../events.js', () => ({
  bus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() },
}));

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: randomUUID(),
    title: 'Test task',
    summary: 'Task summary',
    branchName: 'feat/test',
    targetFiles: [],
    status: 'pending',
    reviewIteration: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeState(overrides: Partial<ProjectState> = {}): ProjectState {
  return {
    projectId: randomUUID(),
    phase: 'requirements',
    projectMode: 'new',
    userInstruction: 'test instruction',
    githubOwner: 'owner',
    githubRepo: 'repo',
    requirementsDoc: '',
    designDoc: '',
    tasks: [],
    currentTaskIndex: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    agentHistories: {
      requirements: null,
      design: null,
      taskDecomp: null,
      coding: null,
      review: null,
      fix: null,
    },
    ...overrides,
  };
}

// --- エージェントモック ---

const mockRequirementsAgent = {
  generateRequirements: vi.fn().mockResolvedValue('# Requirements\n...'),
  reviseRequirements: vi.fn().mockResolvedValue('# Requirements revised\n...'),
  getHistory: vi.fn().mockReturnValue(null),
  setModelOverride: vi.fn(),
};

const mockRequirementsValidationAgent = {
  validate: vi.fn().mockResolvedValue({
    score: 85,
    grade: 'B',
    summary: 'Good requirements',
    issues: [],
    recommendations: [],
    categories: {
      completeness: { score: 17, comment: 'Complete' },
      clarity: { score: 17, comment: 'Clear' },
      testability: { score: 17, comment: 'Testable' },
      consistency: { score: 17, comment: 'Consistent' },
      feasibility: { score: 17, comment: 'Feasible' },
    },
  }),
  getHistory: vi.fn().mockReturnValue(null),
};

const mockDesignAgent = {
  generateDesign: vi.fn().mockResolvedValue('# Design\n...'),
  reviseDesign: vi.fn().mockResolvedValue('# Design revised\n...'),
  getHistory: vi.fn().mockReturnValue(null),
  setModelOverride: vi.fn(),
};

const mockDesignValidationAgent = {
  validate: vi.fn().mockResolvedValue({
    score: 80,
    grade: 'B',
    summary: 'Good design',
    issues: [],
    recommendations: [],
    categories: {
      requirementsCoverage: { score: 16, comment: 'Good coverage' },
      architectureQuality: { score: 16, comment: 'Good architecture' },
      implementability: { score: 16, comment: 'Implementable' },
      riskAwareness: { score: 16, comment: 'Risks identified' },
      maintainability: { score: 16, comment: 'Maintainable' },
    },
  }),
  getHistory: vi.fn().mockReturnValue(null),
};

const mockTaskDecompAgent = {
  decomposeTask: vi.fn().mockResolvedValue([makeTask()]),
  getHistory: vi.fn().mockReturnValue(null),
};

const mockCodingAgent = {
  generateCode: vi.fn().mockResolvedValue({
    files: [{ path: 'src/index.ts', content: 'export {};' }],
    commitMessage: 'feat: implement task',
    prTitle: 'feat: implement task',
    prBody: 'Implementation PR',
  }),
  getHistory: vi.fn().mockReturnValue(null),
  setModelOverride: vi.fn(),
};

const mockReviewAgent = {
  reviewPr: vi.fn().mockResolvedValue({
    approved: true,
    comments: [],
    summary: 'LGTM',
  }),
  reReviewAfterFix: vi.fn().mockResolvedValue({
    approved: true,
    comments: [],
    summary: 'LGTM after fix',
  }),
  getHistory: vi.fn().mockReturnValue(null),
  setModelOverride: vi.fn(),
};

const mockFixAgent = {
  fixCode: vi.fn().mockResolvedValue({
    files: [{ path: 'src/index.ts', content: 'export const fixed = true;' }],
    commitMessage: 'fix: address review feedback',
    fixSummary: 'Fixed review comments',
  }),
  getHistory: vi.fn().mockReturnValue(null),
  setModelOverride: vi.fn(),
};

const mockGitHubAgent = {
  createRepo: vi.fn().mockResolvedValue(undefined),
  createBranch: vi.fn().mockResolvedValue(undefined),
  commitFiles: vi.fn().mockResolvedValue(true),
  readFiles: vi.fn().mockResolvedValue({}),
  createPr: vi.fn().mockResolvedValue({ prNumber: 1, prUrl: 'https://github.com/owner/repo/pull/1' }),
  findOpenPrForBranch: vi.fn().mockResolvedValue(null),
  getPrDiff: vi.fn().mockResolvedValue('diff content'),
  mergePr: vi.fn().mockResolvedValue(undefined),
  postReviewComments: vi.fn().mockResolvedValue(undefined),
  approvePr: vi.fn().mockResolvedValue(undefined),
  requestChanges: vi.fn().mockResolvedValue(undefined),
  commentIssue: vi.fn().mockResolvedValue(undefined),
  closeIssue: vi.fn().mockResolvedValue(undefined),
  pathExistsInWorktree: vi.fn().mockResolvedValue(true),
  runCommandInWorktree: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, timedOut: false }),
  getRepositoryContext: vi.fn().mockResolvedValue(''),
  createIssue: vi.fn().mockResolvedValue({ issueNumber: 10, issueUrl: 'https://github.com/owner/repo/issues/10' }),
  syncContextWorktree: vi.fn().mockResolvedValue({ path: '/tmp', branch: 'main', commit: 'abc' }),
  syncProductWorktree: vi.fn().mockResolvedValue(null),
};

const mockRepoContextSummaryAgent = {
  summarize: vi.fn().mockResolvedValue(undefined),
  getHistory: vi.fn().mockReturnValue(null),
};

const mockCodexAgent = {
  implementTask: vi.fn().mockResolvedValue(undefined),
  getHistory: vi.fn().mockReturnValue(null),
  setModelOverride: vi.fn(),
};

vi.mock('../agents/requirements-agent.js', () => ({
  RequirementsAgent: vi.fn().mockImplementation(function() { return mockRequirementsAgent; }),
}));

vi.mock('../agents/requirements-validation-agent.js', () => ({
  RequirementsValidationAgent: vi.fn().mockImplementation(function() { return mockRequirementsValidationAgent; }),
}));

vi.mock('../agents/design-agent.js', () => ({
  DesignAgent: vi.fn().mockImplementation(function() { return mockDesignAgent; }),
}));

vi.mock('../agents/design-validation-agent.js', () => ({
  DesignValidationAgent: vi.fn().mockImplementation(function() { return mockDesignValidationAgent; }),
}));

vi.mock('../agents/task-decomp-agent.js', () => ({
  TaskDecompAgent: vi.fn().mockImplementation(function() { return mockTaskDecompAgent; }),
}));

vi.mock('../agents/coding-agent.js', () => ({
  CodingAgent: vi.fn().mockImplementation(function() { return mockCodingAgent; }),
}));

vi.mock('../agents/review-agent.js', () => ({
  ReviewAgent: vi.fn().mockImplementation(function() { return mockReviewAgent; }),
}));

vi.mock('../agents/fix-agent.js', () => ({
  FixAgent: vi.fn().mockImplementation(function() { return mockFixAgent; }),
}));

vi.mock('../agents/github-agent.js', () => ({
  GitHubAgent: vi.fn().mockImplementation(function() { return mockGitHubAgent; }),
}));

vi.mock('../agents/repo-context-summary-agent.js', () => ({
  RepoContextSummaryAgent: vi.fn().mockImplementation(function() { return mockRepoContextSummaryAgent; }),
}));

vi.mock('../agents/codex-agent.js', () => ({
  CodexAgent: vi.fn().mockImplementation(function() { return mockCodexAgent; }),
}));

// StateManager はリアルなファイルシステムを使う（一時ディレクトリ）
// Orchestrator を遅延インポートして、すべてのモックが適用された後に読み込む
const { Orchestrator } = await import('../orchestrator.js');

describe('Orchestrator', () => {
  let statePath: string;

  beforeEach(() => {
    statePath = join(tmpdir(), `ace-orchestrator-test-${randomUUID()}`, 'state.json');
    process.env.BUILD_CHECK_ENABLED = 'false';
    delete process.env.COVERAGE_CHECK_ENABLED;
    delete process.env.COVERAGE_CHECK_STRICT;
    vi.clearAllMocks();
    // Re-establish default mock return values after clearAllMocks
    mockCodingAgent.generateCode.mockResolvedValue({
      files: [{ path: 'src/index.ts', content: 'export {};' }],
      commitMessage: 'feat: implement task',
      prTitle: 'feat: implement task',
      prBody: 'Implementation PR',
    });
    mockGitHubAgent.commitFiles.mockResolvedValue(true);
    mockGitHubAgent.readFiles.mockResolvedValue({});
    mockGitHubAgent.pathExistsInWorktree.mockResolvedValue(true);
    mockGitHubAgent.runCommandInWorktree.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, timedOut: false });
    mockReviewAgent.reviewPr.mockResolvedValue({
      approved: true,
      comments: [],
      summary: 'LGTM',
    });
    mockReviewAgent.reReviewAfterFix.mockResolvedValue({
      approved: true,
      comments: [],
      summary: 'LGTM after fix',
    });
    mockFixAgent.fixCode.mockResolvedValue({
      files: [{ path: 'src/index.ts', content: 'export const fixed = true;' }],
      commitMessage: 'fix: address review feedback',
      fixSummary: 'Fixed review comments',
    });
  });

  afterEach(async () => {
    const { promises: fs } = await import('fs');
    await fs.rm(join(statePath, '..'), { recursive: true, force: true }).catch(() => {});
  });

  describe('runPhase1()', () => {
    it('confirmTasks が承認した場合は tasks:set まで到達する', async () => {
      const orchestrator = new Orchestrator(statePath);
      const confirmTasks = vi.fn().mockResolvedValue(true);

      const state = await orchestrator.runPhase1(
        'Build a web app',
        'owner',
        'repo',
        { confirmTasks }
      );

      expect(confirmTasks).toHaveBeenCalledOnce();
      expect(mockTaskDecompAgent.decomposeTask).toHaveBeenCalled();
      expect(state.phase).not.toBe('aborted');
    });

    it('confirmTasks が拒否した場合は phase=aborted になる', async () => {
      const orchestrator = new Orchestrator(statePath);
      const confirmTasks = vi.fn().mockResolvedValue(false);

      const state = await orchestrator.runPhase1(
        'Build a web app',
        'owner',
        'repo',
        { confirmTasks }
      );

      expect(state.phase).toBe('aborted');
    });

    it('confirmTasks が未指定の場合は自動で起票まで進む', async () => {
      const orchestrator = new Orchestrator(statePath);

      const state = await orchestrator.runPhase1(
        'Build a web app',
        'owner',
        'repo'
      );

      expect(mockGitHubAgent.createIssue).toHaveBeenCalled();
    });

    it('projectMode=new のとき createRepo を呼ぶ', async () => {
      const orchestrator = new Orchestrator(statePath);

      await orchestrator.runPhase1('instruction', 'owner', 'repo', { projectMode: 'new' });

      expect(mockGitHubAgent.createRepo).toHaveBeenCalledWith('owner', 'repo');
    });

    it('projectMode=modify のとき createRepo を呼ばない', async () => {
      mockGitHubAgent.getRepositoryContext.mockResolvedValue('existing context');
      const orchestrator = new Orchestrator(statePath);

      await orchestrator.runPhase1('instruction', 'owner', 'repo', { projectMode: 'modify' });

      expect(mockGitHubAgent.createRepo).not.toHaveBeenCalled();
    });

    it('createRepo がリポジトリ既存エラーを返しても継続する', async () => {
      mockGitHubAgent.createRepo.mockRejectedValueOnce(new Error('already exists'));
      const orchestrator = new Orchestrator(statePath);

      await expect(
        orchestrator.runPhase1('instruction', 'owner', 'repo')
      ).resolves.toBeDefined();
    });
  });

  describe('runPhase2()', () => {
    it('state がない場合は例外をスローする', async () => {
      const orchestrator = new Orchestrator(statePath);
      await expect(orchestrator.runPhase2()).rejects.toThrow('No state or tasks');
    });

    it('tasks が空の場合は例外をスローする', async () => {
      const orchestrator = new Orchestrator(statePath);
      // まず state を初期化してから tasks を空にする
      await orchestrator.runPhase1('instruction', 'owner', 'repo', {
        confirmTasks: vi.fn().mockResolvedValue(false),
      });

      // phase=aborted で tasks=[] になっているので、正常に load できるが tasks がない
      // 代わりに手動で state を保存
      const { StateManager } = await import('../state/manager.js');
      const sm = new StateManager(statePath);
      await sm.initialize('test', 'owner', 'repo');

      await expect(orchestrator.runPhase2()).rejects.toThrow('No state or tasks');
    });

    it('pending タスクを処理して merged に更新する', async () => {
      // まず phase1 でタスクを作成
      const orchestrator = new Orchestrator(statePath);
      await orchestrator.runPhase1('instruction', 'owner', 'repo');

      // phase2 を実行
      await orchestrator.runPhase2();

      // CodingAgent.generateCode が呼ばれたことを確認
      expect(mockCodingAgent.generateCode).toHaveBeenCalled();
    });

    it('skipped タスクは処理せず completed にしない', async () => {
      const { StateManager } = await import('../state/manager.js');
      const sm = new StateManager(statePath);
      await sm.initialize('instruction', 'owner', 'repo');
      await sm.setTasks([makeTask({ status: 'skipped' })]);

      const orchestrator = new Orchestrator(statePath);
      await orchestrator.runPhase2();

      const saved = await sm.load();
      expect(mockCodingAgent.generateCode).not.toHaveBeenCalled();
      expect(saved?.phase).not.toBe('completed');
      expect(saved?.tasks[0].status).toBe('skipped');
    });

    it('レビューがblockingを返した場合は FixAgent に委譲して再レビューする', async () => {
      mockReviewAgent.reviewPr.mockResolvedValueOnce({
        approved: false,
        comments: [{
          path: 'src/index.ts',
          line: 1,
          body: 'Fix this behavior',
          severity: 'blocking',
        }],
        summary: 'Needs fix',
      });
      mockReviewAgent.reReviewAfterFix.mockResolvedValueOnce({
        approved: true,
        comments: [],
        summary: 'LGTM after fix',
      });

      const orchestrator = new Orchestrator(statePath);
      await orchestrator.runPhase1('instruction', 'owner', 'repo');
      await orchestrator.runPhase2();

      expect(mockFixAgent.fixCode).toHaveBeenCalledOnce();
      expect(mockReviewAgent.reReviewAfterFix).toHaveBeenCalledOnce();
      expect(mockGitHubAgent.mergePr).toHaveBeenCalled();
    });

    it('LlmUsageLimitError が発生したとき task を failed にしてリスロー', async () => {
      const { LlmUsageLimitError } = await import('../utils/llm-errors.js');
      mockCodingAgent.generateCode.mockRejectedValueOnce(
        new LlmUsageLimitError('claude', 'usage limit reached')
      );

      const orchestrator = new Orchestrator(statePath);
      await orchestrator.runPhase1('instruction', 'owner', 'repo');

      await expect(orchestrator.runPhase2()).rejects.toThrow('usage limit');
    });
  });

  describe('deterministic build checks', () => {
    async function prepareTaskState(task: Task = makeTask()): Promise<{ orchestrator: any; state: ProjectState; task: Task }> {
      const orchestrator = new Orchestrator(statePath) as any;
      const { StateManager } = await import('../state/manager.js');
      const sm = new StateManager(statePath);
      await sm.initialize('instruction', 'owner', 'repo');
      await sm.setTasks([task]);
      const state = await sm.load();
      if (!state) throw new Error('state not found');
      return { orchestrator, state, task };
    }

    it('BUILD_CHECK_ENABLED=false のとき warning comment と lastChecks を残す', async () => {
      process.env.BUILD_CHECK_ENABLED = 'false';
      const { orchestrator, state, task } = await prepareTaskState();

      const comments = await orchestrator._runBuildCheck(mockGitHubAgent, state, task);

      expect(comments[0].severity).toBe('suggestion');
      expect(comments[0].body).toContain('BUILD_CHECK_ENABLED=false');

      const { StateManager } = await import('../state/manager.js');
      const saved = await new StateManager(statePath).load();
      expect(saved?.tasks[0].lastChecks?.find((check) => check.name === 'build-gate')?.status).toBe('skipped');
    });

    it('package-lock.json がある場合は npm ci で依存を入れる', async () => {
      process.env.BUILD_CHECK_ENABLED = 'true';
      const { orchestrator, state, task } = await prepareTaskState();
      mockGitHubAgent.readFiles
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({
          'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }),
          'package-lock.json': '{}',
        });
      mockGitHubAgent.pathExistsInWorktree.mockResolvedValue(false);
      mockGitHubAgent.runCommandInWorktree.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, timedOut: false });

      await orchestrator._runBuildCheck(mockGitHubAgent, state, task);

      expect(mockGitHubAgent.runCommandInWorktree).toHaveBeenCalledWith(
        'owner',
        'repo',
        task.branchName,
        'npm',
        ['ci'],
        180000
      );
    });

    it('coverage有効で test:coverage がない場合は未計測を可視化する', async () => {
      process.env.BUILD_CHECK_ENABLED = 'true';
      process.env.COVERAGE_CHECK_ENABLED = 'true';
      const { orchestrator, state, task } = await prepareTaskState();
      mockGitHubAgent.readFiles
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({
          'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }),
        });
      mockGitHubAgent.pathExistsInWorktree.mockResolvedValue(true);
      mockGitHubAgent.runCommandInWorktree.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, timedOut: false });

      const comments = await orchestrator._runBuildCheck(mockGitHubAgent, state, task);

      expect(comments.some((comment: any) => comment.body.includes('カバレッジ未計測'))).toBe(true);
      const { StateManager } = await import('../state/manager.js');
      const saved = await new StateManager(statePath).load();
      expect(saved?.tasks[0].lastChecks?.find((check) => check.name === 'coverage')?.status).toBe('warning');
    });

    it('テストケース削除・無効化・弱体化を blocking として検出する', () => {
      const orchestrator = new Orchestrator(statePath) as any;
      const diff = [
        'diff --git a/src/foo.test.ts b/src/foo.test.ts',
        '@@',
        "-it('keeps behavior', () => {",
        '-  expect(result).toBe(42);',
        '+it.skip(\'keeps behavior\', () => {',
        '+  expect(result).toBeDefined();',
      ].join('\n');

      const comments = orchestrator._detectTestDeletion(diff);

      expect(comments.map((comment: any) => comment.body).join('\n')).toContain('テスト無効化禁止');
      expect(comments.map((comment: any) => comment.body).join('\n')).toContain('テストケース削除禁止');
      expect(comments.map((comment: any) => comment.body).join('\n')).toContain('アサーション削除禁止');
      expect(comments.map((comment: any) => comment.body).join('\n')).toContain('アサーション弱体化禁止');
      expect(comments.every((comment: any) => comment.severity === 'blocking')).toBe(true);
    });
  });
});
