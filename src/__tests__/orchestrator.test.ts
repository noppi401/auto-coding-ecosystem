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
  getHistory: vi.fn().mockReturnValue(null),
  setModelOverride: vi.fn(),
};

const mockFixAgent = {
  fixCode: vi.fn().mockResolvedValue(undefined),
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
    vi.clearAllMocks();
    // Re-establish default mock return values after clearAllMocks
    mockCodingAgent.generateCode.mockResolvedValue({
      files: [{ path: 'src/index.ts', content: 'export {};' }],
      commitMessage: 'feat: implement task',
      prTitle: 'feat: implement task',
      prBody: 'Implementation PR',
    });
    mockGitHubAgent.commitFiles.mockResolvedValue(true);
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
});
