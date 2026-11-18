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
  runSmokeCheckInWorktree: vi.fn().mockResolvedValue({ status: 'passed', summary: 'ok' }),
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

const mockAcceptanceAgent = {
  generateAcceptanceTests: vi.fn(),
  getHistory: vi.fn().mockReturnValue(null),
};

vi.mock('../agents/acceptance-test-agent.js', () => ({
  AcceptanceTestAgent: vi.fn().mockImplementation(function() { return mockAcceptanceAgent; }),
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

// モックの getPrDiff は常に同じ diff を返すため、push 直後の再取得待ち（既定 3 秒 × 4 回）を 0 にする
process.env.PR_DIFF_REFETCH_DELAY_MS = '0';

describe('Orchestrator', () => {
  let statePath: string;

  beforeEach(() => {
    statePath = join(tmpdir(), `ace-orchestrator-test-${randomUUID()}`, 'state.json');
    process.env.BUILD_CHECK_ENABLED = 'false';
    // 受け入れタスクの自動追加は専用のテストで検証する（他のテストはタスク 1 件の流れを前提にする）
    process.env.ACCEPTANCE_TASK_ENABLED = 'false';
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
    mockGitHubAgent.getPrDiff.mockResolvedValue('diff content');
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

    it('新規プロジェクトでも、対象・テストファイルの既存内容と他タスクの計画を CodingAgent に渡す', async () => {
      const { StateManager } = await import('../state/manager.js');
      const sm = new StateManager(statePath);
      await sm.initialize('instruction', 'owner', 'repo'); // projectMode は modify ではない
      await sm.setTasks([
        makeTask({ id: 't-a', title: 'Server', targetFiles: ['server.js'], testFiles: ['server.test.js'] }),
        makeTask({ id: 't-b', title: 'GET endpoint', targetFiles: ['server.js'], testFiles: ['server.test.js'] }),
      ]);
      mockGitHubAgent.readFiles.mockImplementation(async (_o: string, _r: string, _b: string, paths: string[]) =>
        Object.fromEntries(paths.filter((p) => p === 'server.js' || p === 'server.test.js').map((p) => [p, `existing ${p}`]))
      );

      const orchestrator = new Orchestrator(statePath);
      await orchestrator.runPhase2();

      const [, , , currentFiles, otherTasks] = mockCodingAgent.generateCode.mock.calls[0];
      expect(currentFiles).toEqual({ 'server.js': 'existing server.js', 'server.test.js': 'existing server.test.js' });
      expect(otherTasks).toContain('GET endpoint');
      expect(otherTasks).not.toContain('- Server:');
    });

    it('ReviewAgent と FixAgent に、変更の有無に関わらず設定ファイル（package.json / tsconfig.json）を渡す', async () => {
      // run 26: tsconfig が CommonJS なのに、レビューが ES モジュールと誤解して __dirname を誤指摘した
      const { StateManager } = await import('../state/manager.js');
      const sm = new StateManager(statePath);
      await sm.initialize('instruction', 'owner', 'repo');
      await sm.setTasks([makeTask({ targetFiles: ['src/handlers.ts'] })]);
      mockGitHubAgent.readFiles.mockImplementation(async (_o: string, _r: string, _b: string, paths: string[]) =>
        Object.fromEntries(paths.filter((p) => ['package.json', 'tsconfig.json', 'src/handlers.ts'].includes(p)).map((p) => [p, `content of ${p}`]))
      );
      mockReviewAgent.reviewPr.mockResolvedValueOnce({
        approved: false,
        comments: [{ path: 'src/handlers.ts', line: 1, body: 'x', severity: 'blocking' }],
        summary: 'fix',
      });

      await new Orchestrator(statePath).runPhase2();

      const reviewFiles = mockReviewAgent.reviewPr.mock.calls[0][5];
      expect(Object.keys(reviewFiles)).toEqual(expect.arrayContaining(['package.json', 'tsconfig.json']));
      const fixFiles = mockFixAgent.fixCode.mock.calls[0][2];
      expect(Object.keys(fixFiles)).toEqual(expect.arrayContaining(['package.json', 'tsconfig.json']));
    });

    describe('受け入れタスク', () => {
      const acceptanceTask = () =>
        makeTask({
          id: 't-acc',
          title: '受け入れテストと起動確認',
          kind: 'acceptance',
          branchName: 'feat/task-002-acceptance',
          targetFiles: ['server.js', 'public/index.html'],
          testFiles: ['test/acceptance.test.js'],
        });

      it('Phase 1 の分解結果の最後に受け入れタスクを追加し、Issue も起票する', async () => {
        process.env.ACCEPTANCE_TASK_ENABLED = 'true';
        mockTaskDecompAgent.decomposeTask.mockResolvedValueOnce([
          makeTask({ title: 'Server', targetFiles: ['server.js'], testFiles: ['test/server.test.js'] }),
        ]);

        const orchestrator = new Orchestrator(statePath);
        const state = await orchestrator.runPhase1('instruction', 'owner', 'repo');

        expect(state.tasks).toHaveLength(2);
        expect(state.tasks[1].kind).toBe('acceptance');
        expect(state.tasks[1].testFiles).toEqual(['test/acceptance.test.js']);
        expect(mockGitHubAgent.createIssue).toHaveBeenCalledTimes(2);
      });

      it('受け入れタスクは CodingAgent ではなく、要件・package.json・ファイル一覧だけを渡して AcceptanceTestAgent で生成する', async () => {
        const { StateManager } = await import('../state/manager.js');
        const sm = new StateManager(statePath);
        await sm.initialize('instruction', 'owner', 'repo');
        await sm.updateRequirementsDoc('REQ: GET / で HTML');
        await sm.setTasks([acceptanceTask()]);
        mockGitHubAgent.readFiles.mockImplementation(async (_o: string, _r: string, _b: string, paths: string[]) =>
          paths.includes('package.json') && paths.length === 1 ? { 'package.json': '{"scripts":{"start":"node server.js"}}' } : {}
        );
        mockGitHubAgent.runCommandInWorktree.mockResolvedValue({ stdout: 'server.js\npublic/index.html\n', stderr: '', exitCode: 0, timedOut: false });
        mockAcceptanceAgent.generateAcceptanceTests.mockResolvedValue({
          files: [{ path: 'test/acceptance.test.js', content: 'test' }],
          commitMessage: 'test: acceptance', prTitle: 't', prBody: 'b',
        });

        await new Orchestrator(statePath).runPhase2();

        expect(mockCodingAgent.generateCode).not.toHaveBeenCalled();
        const [, req, pkg, files] = mockAcceptanceAgent.generateAcceptanceTests.mock.calls[0];
        expect(req).toBe('REQ: GET / で HTML');
        expect(pkg).toContain('node server.js');
        expect(files).toEqual(['server.js', 'public/index.html']);
      });

      it('FixAgent には全実装ファイルを渡し、受け入れテストへの変更は無視して実装の変更だけをコミットする', async () => {
        const { StateManager } = await import('../state/manager.js');
        const sm = new StateManager(statePath);
        await sm.initialize('instruction', 'owner', 'repo');
        await sm.setTasks([acceptanceTask()]);
        mockGitHubAgent.readFiles.mockImplementation(async (_o: string, _r: string, _b: string, paths: string[]) =>
          Object.fromEntries(paths.map((p) => [p, `content of ${p}`]))
        );
        mockAcceptanceAgent.generateAcceptanceTests.mockResolvedValue({
          files: [{ path: 'test/acceptance.test.js', content: 'test' }],
          commitMessage: 'test: acceptance', prTitle: 't', prBody: 'b',
        });
        mockReviewAgent.reviewPr.mockResolvedValueOnce({
          approved: false,
          comments: [{ path: 'server.js', line: 1, body: 'GET / が 403', severity: 'blocking' }],
          summary: 'fix',
        });
        // 実際の PR と同じく、受け入れテストはこの PR で追加されたファイルとして差分に含まれる（FixAgent にも見えている）
        mockGitHubAgent.getPrDiff.mockResolvedValue(
          'diff --git a/test/acceptance.test.js b/test/acceptance.test.js\nnew file mode 100644\n--- /dev/null\n+++ b/test/acceptance.test.js\n@@ -0,0 +1 @@\n+test'
        );
        mockFixAgent.fixCode.mockResolvedValueOnce({
          files: [
            { path: 'test/acceptance.test.js', content: 'weakened test' },
            { path: 'server.js', content: 'fixed server' },
          ],
          commitMessage: 'fix', fixSummary: '',
        });

        await new Orchestrator(statePath).runPhase2();

        const fixInputFiles = mockFixAgent.fixCode.mock.calls[0][2];
        expect(Object.keys(fixInputFiles)).toEqual(expect.arrayContaining(['server.js', 'public/index.html', 'test/acceptance.test.js']));
        const fixCommit = mockGitHubAgent.commitFiles.mock.calls[1];
        expect(fixCommit[3].map((f: any) => f.path)).toEqual(['server.js']);
      });
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

    describe('起動確認ゲート（受け入れタスクのみ）', () => {
      const runGate = async (kind: 'acceptance' | undefined, smoke: { status: string; summary: string; details?: string }) => {
        process.env.BUILD_CHECK_ENABLED = 'true';
        const { orchestrator, state, task } = await prepareTaskState();
        task.kind = kind;
        mockGitHubAgent.readFiles
          .mockResolvedValueOnce({})
          .mockResolvedValueOnce({ 'package.json': JSON.stringify({ scripts: { test: 'node --test', start: 'node server.js' } }) });
        mockGitHubAgent.pathExistsInWorktree.mockResolvedValue(true);
        mockGitHubAgent.runCommandInWorktree.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, timedOut: false });
        mockGitHubAgent.runSmokeCheckInWorktree.mockClear();
        mockGitHubAgent.runSmokeCheckInWorktree.mockResolvedValue(smoke);
        const comments = await orchestrator._runBuildCheck(mockGitHubAgent, state, task);
        const { StateManager } = await import('../state/manager.js');
        const saved = await new StateManager(statePath).load();
        return { comments, check: saved?.tasks[0].lastChecks?.find((c) => c.name === 'smoke') };
      };

      it('受け入れタスクで起動確認が失敗したら、エントリファイルを対象に blocking にする', async () => {
        const { comments, check } = await runGate('acceptance', {
          status: 'failed',
          summary: '起動確認失敗: GET / が 403 を返した',
          details: 'Forbidden',
        });
        const blocking = comments.filter((c: any) => c.severity === 'blocking');
        expect(blocking).toHaveLength(1);
        expect(blocking[0].path).toBe('server.js');
        expect(blocking[0].body).toContain('403');
        expect(check?.status).toBe('failed');
      });

      it('受け入れタスクで起動確認が通れば指摘しない', async () => {
        const { comments, check } = await runGate('acceptance', { status: 'passed', summary: 'GET / -> 200' });
        expect(comments.filter((c: any) => c.severity === 'blocking')).toHaveLength(0);
        expect(check?.status).toBe('passed');
      });

      it('通常のタスクでは起動確認を実行しない', async () => {
        const { check } = await runGate(undefined, { status: 'failed', summary: 'x' });
        expect(mockGitHubAgent.runSmokeCheckInWorktree).not.toHaveBeenCalled();
        expect(check).toBeUndefined();
      });
    });

    describe('test script が一部のテストしか実行しない場合を検知する', () => {
      const runGate = async (testScript: string, trackedFiles: string[]) => {
        process.env.BUILD_CHECK_ENABLED = 'true';
        const { orchestrator, state, task } = await prepareTaskState();
        mockGitHubAgent.readFiles
          .mockResolvedValueOnce({})
          .mockResolvedValueOnce({ 'package.json': JSON.stringify({ scripts: { test: testScript } }) });
        mockGitHubAgent.pathExistsInWorktree.mockResolvedValue(true);
        mockGitHubAgent.runCommandInWorktree.mockImplementation(
          async (_o: string, _r: string, _b: string, cmd: string) => ({
            stdout: cmd === 'git' ? trackedFiles.join('\n') : '',
            stderr: '',
            exitCode: 0,
            timedOut: false,
          })
        );
        const comments = await orchestrator._runBuildCheck(mockGitHubAgent, state, task);
        const { StateManager } = await import('../state/manager.js');
        const saved = await new StateManager(statePath).load();
        const check = saved?.tasks[0].lastChecks?.find((c) => c.name === 'test-coverage-of-script');
        return { comments, check };
      };

      it('npm test が通っても、未実行のテストファイルがあれば blocking にする', async () => {
        const { comments, check } = await runGate('node --test tests/api.test.js', [
          'tests/api.test.js',
          'tests/integration.test.js',
        ]);

        const blocking = comments.filter((c: any) => c.severity === 'blocking');
        expect(blocking).toHaveLength(1);
        expect(blocking[0].path).toBe('package.json');
        expect(blocking[0].body).toContain('tests/integration.test.js');
        expect(blocking[0].body).not.toContain('- tests/api.test.js');
        expect(check?.status).toBe('failed');
      });

      it('全テストを実行する script なら指摘しない', async () => {
        const { comments, check } = await runGate('node --test', [
          'tests/api.test.js',
          'tests/integration.test.js',
        ]);

        expect(comments.filter((c: any) => c.severity === 'blocking')).toHaveLength(0);
        expect(check?.status).toBe('passed');
      });
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
      // expect は 1 件消えて 1 件増えた（純減なし）ため削除ではなく、弱いアサーションへの置き換えとして検出される
      expect(comments.map((comment: any) => comment.body).join('\n')).toContain('アサーション弱体化禁止');
      expect(comments.every((comment: any) => comment.severity === 'blocking')).toBe(true);
    });

    describe('テストケース・アサーションの削除は、ファイル単位の純減だけを止める', () => {
      const detect = (fileLines: string[]) => {
        const orchestrator = new Orchestrator(statePath) as any;
        const diff = ['diff --git a/test/api.test.js b/test/api.test.js', '@@', ...fileLines].join('\n');
        return orchestrator._detectTestDeletion(diff).map((c: any) => c.body).join('\n');
      };

      it('古い挙動のテストを新しい挙動に書き換える（同数の置き換え）は通す', () => {
        const bodies = detect([
          "-  it('GET /api/todos は 501 を返す', async () => {",
          "-    expect(res.status).toBe(501);",
          "+  it('GET /api/todos は 200 を返す', async () => {",
          "+    expect(res.status).toBe(200);",
        ]);
        expect(bodies).toBe('');
      });

      it('壊れた残骸の it( を消しつつテストを追加した場合（純増）は通す', () => {
        const bodies = detect([
          "-    it('GET /api/todos はハンドラーにルーティングされる（現在 501）', async () => {",
          "+    it('GET /api/todos は 200 OK を返す', async () => {",
          "+  it('空リストなら空配列を返す', async () => {",
        ]);
        expect(bodies).toBe('');
      });

      it('テストケースが純減した場合（26 件 → 23 件相当）は blocking にする', () => {
        const bodies = detect([
          "-  it('a', () => {",
          "-  it('b', () => {",
          "-  test('c', () => {",
          "+  it('a2', () => {",
        ]);
        expect(bodies).toContain('テストケース削除禁止');
        expect(bodies).toContain('2 件');
      });

      it('アサーションが純減した場合は blocking にする', () => {
        const bodies = detect(['-    expect(a).toBe(1);', '-    expect(b).toBe(2);', '+    expect(a).toBe(1);']);
        expect(bodies).toContain('アサーション削除禁止');
      });

      it('純減の判定はファイルごとに行う（別ファイルの追加で相殺しない）', () => {
        const orchestrator = new Orchestrator(statePath) as any;
        const diff = [
          'diff --git a/test/a.test.js b/test/a.test.js',
          "-  it('x', () => {",
          'diff --git a/test/b.test.js b/test/b.test.js',
          "+  it('y', () => {",
        ].join('\n');
        const comments = orchestrator._detectTestDeletion(diff);
        expect(comments.map((c: any) => c.path)).toEqual(['test/a.test.js']);
      });
    });

    describe('テスト無効化の判定は、テストランナーの skip/todo 呼び出しに限る', () => {
      const disabledComments = (addedLine: string) => {
        const orchestrator = new Orchestrator(statePath) as any;
        const diff = ['diff --git a/tests/app.test.js b/tests/app.test.js', '@@', `+${addedLine}`].join('\n');
        return orchestrator
          ._detectTestDeletion(diff)
          .filter((comment: any) => comment.body.includes('テスト無効化禁止'));
      };

      // ToDo アプリでは変数名 todo / skip が自然に現れる。これらを無効化と誤判定しない。
      it.each([
        "  assert.equal(typeof todo.id, 'number');",
        '  const result = todo.title;',
        '  expect(todo.completed).toBe(false);',
        '  const next = skip(items, 2);',
        '  list.skip(3);',
      ])('変数名・通常の呼び出しは無効化と誤判定しない: %s', (line) => {
        expect(disabledComments(line)).toHaveLength(0);
      });

      it.each([
        "it.skip('x', () => {});",
        "  test.skip('x', () => {});",
        "describe.skip('suite', () => {});",
        "  it.todo('later');",
        "test.todo('later');",
        "xit('x', () => {});",
        "xtest('x', () => {});",
      ])('テストランナーの無効化は検出する: %s', (line) => {
        expect(disabledComments(line)).toHaveLength(1);
      });
    });
  });
});
