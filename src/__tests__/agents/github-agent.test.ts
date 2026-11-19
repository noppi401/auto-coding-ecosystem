import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { GitHubAgent } from '../../agents/github-agent.js';

vi.mock('../../utils/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), section: vi.fn() },
}));

describe('GitHubAgent', () => {
  let checkoutPath: string;
  let origEnv: Record<string, string | undefined>;

  beforeEach(() => {
    checkoutPath = join(tmpdir(), `ace-github-agent-test-${randomUUID()}`, 'repo');
    origEnv = {
      ECOSYSTEM_PRODUCT_WORKTREE: process.env.ECOSYSTEM_PRODUCT_WORKTREE,
      ECOSYSTEM_PRODUCT_ROOT: process.env.ECOSYSTEM_PRODUCT_ROOT,
    };
    delete process.env.ECOSYSTEM_PRODUCT_WORKTREE;
    delete process.env.ECOSYSTEM_PRODUCT_ROOT;
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(origEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(join(checkoutPath, '..'), { recursive: true, force: true }).catch(() => {});
  });

  function mockDirtyCheckout(agent: GitHubAgent, status: string) {
    vi.spyOn(agent as any, 'pathExists').mockResolvedValue(true);
    return vi.spyOn(agent as any, 'exec').mockImplementation(async (_command: string, args: string[]) => {
      if (args[0] === 'status' && args[1] === '--porcelain') {
        return status;
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });
  }

  describe('excludeBuildArtifacts（node_modules / dist を git add . から除外）', () => {
    const git = async (args: string[], cwd: string) => {
      const { execFile } = await import('child_process');
      const { promisify } = await import('util');
      const { stdout } = await promisify(execFile)('git', args, { cwd });
      return stdout;
    };

    async function setupRepo(gitignore?: string): Promise<string> {
      await fs.mkdir(checkoutPath, { recursive: true });
      await git(['init', '-q'], checkoutPath);
      if (gitignore !== undefined) await fs.writeFile(join(checkoutPath, '.gitignore'), gitignore);
      for (const f of ['src/a.ts', 'node_modules/pkg/index.js', 'dist/src/a.js']) {
        await fs.mkdir(join(checkoutPath, f, '..'), { recursive: true });
        await fs.writeFile(join(checkoutPath, f), 'x');
      }
      return checkoutPath;
    }

    const stagedFiles = async (dir: string) =>
      (await git(['ls-files', '--cached'], dir)).split('\n').map((s) => s.trim()).filter(Boolean);

    it('.gitignore が無いリポジトリでも node_modules と dist をステージしない', async () => {
      const dir = await setupRepo();
      await (new GitHubAgent() as any).excludeBuildArtifacts(dir);
      await git(['add', '.'], dir);

      expect(await stagedFiles(dir)).toEqual(['src/a.ts']);
    });

    it('呼び出しを繰り返しても除外エントリを重複追記しない', async () => {
      const dir = await setupRepo();
      const agent = new GitHubAgent() as any;
      await agent.excludeBuildArtifacts(dir);
      await agent.excludeBuildArtifacts(dir);

      const exclude = await fs.readFile(join(dir, '.git', 'info', 'exclude'), 'utf-8');
      expect(exclude.split('\n').filter((l) => l.trim() === 'node_modules/')).toHaveLength(1);
    });

    it('既存の .gitignore は書き換えない', async () => {
      const dir = await setupRepo('custom-ignore\n');
      await (new GitHubAgent() as any).excludeBuildArtifacts(dir);

      expect(await fs.readFile(join(dir, '.gitignore'), 'utf-8')).toBe('custom-ignore\n');
    });
  });

  it('createRepo は gh repo create を正しい引数で呼ぶ', async () => {
    const agent = new GitHubAgent();
    const execSpy = vi.spyOn(agent as any, 'exec').mockResolvedValue('');

    await agent.createRepo('owner', 'repo');

    expect(execSpy).toHaveBeenCalledWith('gh', [
      'repo',
      'create',
      'owner/repo',
      '--public',
      '--add-readme',
    ]);
  });

  it('createPr は gh pr create の出力からPR番号とURLを返す', async () => {
    const agent = new GitHubAgent();
    const execSpy = vi.spyOn(agent as any, 'exec').mockResolvedValue(
      'https://github.com/owner/repo/pull/123\n'
    );

    const pr = await agent.createPr('owner', 'repo', 'feat/test', 'PR title', 'PR body');

    expect(pr).toEqual({
      prNumber: 123,
      prUrl: 'https://github.com/owner/repo/pull/123',
    });
    expect(execSpy).toHaveBeenCalledWith('gh', expect.arrayContaining([
      'pr',
      'create',
      '--repo',
      'owner/repo',
      '--title',
      'PR title',
      '--body',
      'PR body',
      '--head',
      'feat/test',
    ]));
  });

  it('getIssue は gh issue view のJSONを SourceIssue にパースする', async () => {
    const agent = new GitHubAgent();
    vi.spyOn(agent as any, 'exec').mockResolvedValue(JSON.stringify({
      number: 42,
      title: 'Fix bug',
      body: 'Issue body',
      url: 'https://github.com/owner/repo/issues/42',
      labels: [{ name: 'bug' }, { name: 'urgent' }],
      updatedAt: '2026-06-06T00:00:00Z',
    }));

    const issue = await agent.getIssue('owner', 'repo', 42);

    expect(issue).toEqual({
      number: 42,
      title: 'Fix bug',
      body: 'Issue body',
      url: 'https://github.com/owner/repo/issues/42',
      labels: ['bug', 'urgent'],
      updatedAt: '2026-06-06T00:00:00Z',
    });
  });

  it('cloneRepo は gh auth token を使って git clone する', async () => {
    const agent = new GitHubAgent();
    const execSpy = vi.spyOn(agent as any, 'exec').mockImplementation(async (command: string, args: string[]) => {
      if (command === 'gh' && args.join(' ') === 'auth token') return 'token-123\n';
      if (command === 'git' && args[0] === 'clone') return '';
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
    });

    await (agent as any).cloneRepo('owner', 'repo', checkoutPath);

    expect(execSpy).toHaveBeenCalledWith('git', [
      'clone',
      'https://x-access-token:token-123@github.com/owner/repo.git',
      checkoutPath,
    ]);
  });

  it('createBranch は既存remote branchがある場合に origin/branch をcheckoutする', async () => {
    const agent = new GitHubAgent();
    vi.spyOn(agent as any, 'pathExists').mockResolvedValue(true);
    vi.spyOn(agent as any, 'ensureBaseBranch').mockResolvedValue(undefined);
    vi.spyOn(agent as any, 'execAllowFailure').mockResolvedValue('abc\trefs/heads/feat/test\n');
    const execSpy = vi.spyOn(agent as any, 'exec').mockResolvedValue('');

    await agent.createBranch('owner', 'repo', 'feat/test');

    expect(execSpy).toHaveBeenCalledWith('git', ['fetch', 'origin', 'feat/test'], expect.any(String));
    expect(execSpy).toHaveBeenCalledWith('git', ['checkout', '-B', 'feat/test', 'origin/feat/test'], expect.any(String));
    expect(execSpy).not.toHaveBeenCalledWith('git', expect.arrayContaining(['push']), expect.any(String));
  });

  it('git/gh コマンド失敗は呼び出し元へ例外として伝播する', async () => {
    const agent = new GitHubAgent();
    vi.spyOn(agent as any, 'exec').mockRejectedValue(new Error('gh failed'));

    await expect(agent.createRepo('owner', 'repo')).rejects.toThrow('gh failed');
  });

  it('dirty な __context worktree はファイル一覧と復旧手順を含めて停止する', async () => {
    const agent = new GitHubAgent();
    const execSpy = mockDirtyCheckout(agent, ' M src/app.ts\n?? notes/local.md\n');

    await expect(
      (agent as any).syncExistingCheckout('owner', 'repo', checkoutPath, 'main', '__context')
    ).rejects.toThrow(/__context:[\s\S]*src\/app\.ts[\s\S]*notes\/local\.md[\s\S]*Recovery/);

    expect(execSpy).toHaveBeenCalledTimes(1);
  });

  it('ECOSYSTEM_PRODUCT_WORKTREE の dirty も対象名とファイル名を表示する', async () => {
    process.env.ECOSYSTEM_PRODUCT_WORKTREE = checkoutPath;
    const agent = new GitHubAgent();
    mockDirtyCheckout(agent, 'M  README.md\n');

    await expect(
      agent.syncProductWorktree('owner', 'repo')
    ).rejects.toThrow(/ECOSYSTEM_PRODUCT_WORKTREE:[\s\S]*README\.md/);
  });

  describe('commitFiles', () => {
    function mockWorktree(agent: GitHubAgent) {
      vi.spyOn(agent as any, 'getWorktreePath').mockReturnValue(checkoutPath);
      vi.spyOn(agent as any, 'pathExists').mockResolvedValue(true);
      // 実際の git と同じく、rev-parse --git-path は除外設定ファイルのパスを返す
      return vi.spyOn(agent as any, 'exec').mockImplementation(async (_command: string, args: string[]) =>
        args[0] === 'status' ? ' M src/a.ts\n' : args[0] === 'rev-parse' ? '.git/info/exclude\n' : ''
      );
    }

    it('worktree 外を指すパスは書き込まずに拒否する', async () => {
      const agent = new GitHubAgent();
      const execSpy = mockWorktree(agent);

      await expect(
        agent.commitFiles('owner', 'repo', 'feat/x', [{ path: '../escape.txt', content: 'x' }], 'msg')
      ).rejects.toThrow('Refusing path outside worktree');

      await expect(fs.access(join(checkoutPath, '..', 'escape.txt'))).rejects.toThrow();
      expect(execSpy).not.toHaveBeenCalled();
    });

    it('書き込んだファイルだけを git add する', async () => {
      const agent = new GitHubAgent();
      const execSpy = mockWorktree(agent);

      await agent.commitFiles('owner', 'repo', 'feat/x', [{ path: 'src/a.ts', content: 'a' }], 'msg');

      expect(await fs.readFile(join(checkoutPath, 'src/a.ts'), 'utf-8')).toBe('a');
      expect(execSpy).toHaveBeenCalledWith('git', ['add', '--', 'src/a.ts'], checkoutPath);
      expect(execSpy).not.toHaveBeenCalledWith('git', ['add', '.'], expect.anything());
    });
  });

  it('exec のエラーメッセージから gh トークンを伏せる', async () => {
    const agent = new GitHubAgent();
    const err = await (agent as any)
      .exec('git', ['-C', join(checkoutPath, 'missing'), 'clone', 'https://x-access-token:secret-123@github.com/o/r.git'])
      .catch((e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).not.toContain('secret-123');
    expect(err.message).toContain('x-access-token:***@');
  });
});
