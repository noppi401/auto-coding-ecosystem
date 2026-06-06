import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GitHubAgent } from '../../agents/github-agent.js';

vi.mock('../../utils/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), section: vi.fn() },
}));

describe('GitHubAgent', () => {
  let agent: GitHubAgent;

  beforeEach(() => {
    agent = new GitHubAgent();
    vi.clearAllMocks();
  });

  describe('createPr()', () => {
    it('PR URL から prNumber と prUrl を正しくパースする', async () => {
      const execSpy = vi.spyOn(agent as any, 'exec').mockResolvedValue(
        'https://github.com/owner/repo/pull/42\n'
      );

      const result = await agent.createPr('owner', 'repo', 'feat/branch', 'PR title', 'PR body');

      expect(result.prNumber).toBe(42);
      expect(result.prUrl).toBe('https://github.com/owner/repo/pull/42');
    });

    it('PR 作成失敗時に既存 PR が見つかればそれを返す', async () => {
      const execSpy = vi.spyOn(agent as any, 'exec')
        .mockRejectedValueOnce(new Error('PR already exists'))
        .mockResolvedValueOnce(
          JSON.stringify([{ number: 10, url: 'https://github.com/owner/repo/pull/10' }])
        );

      const result = await agent.createPr('owner', 'repo', 'feat/branch', 'title', 'body');

      expect(result.prNumber).toBe(10);
      expect(result.prUrl).toBe('https://github.com/owner/repo/pull/10');
    });

    it('PR 作成失敗かつ既存 PR もない場合は例外をスローする', async () => {
      vi.spyOn(agent as any, 'exec')
        .mockRejectedValueOnce(new Error('gh pr create failed'))
        .mockResolvedValueOnce(JSON.stringify([]));

      await expect(
        agent.createPr('owner', 'repo', 'feat/branch', 'title', 'body')
      ).rejects.toThrow();
    });
  });

  describe('findOpenPrForBranch()', () => {
    it('PR が見つかったとき prNumber と prUrl を返す', async () => {
      vi.spyOn(agent as any, 'execAllowFailure').mockResolvedValue(
        JSON.stringify([{ number: 7, url: 'https://github.com/owner/repo/pull/7' }])
      );

      const result = await agent.findOpenPrForBranch('owner', 'repo', 'feat/x');

      expect(result?.prNumber).toBe(7);
      expect(result?.prUrl).toBe('https://github.com/owner/repo/pull/7');
    });

    it('PR が空リストのとき null を返す', async () => {
      vi.spyOn(agent as any, 'execAllowFailure').mockResolvedValue(JSON.stringify([]));
      const result = await agent.findOpenPrForBranch('owner', 'repo', 'feat/x');
      expect(result).toBeNull();
    });

    it('空文字列のとき null を返す', async () => {
      vi.spyOn(agent as any, 'execAllowFailure').mockResolvedValue('');
      const result = await agent.findOpenPrForBranch('owner', 'repo', 'feat/x');
      expect(result).toBeNull();
    });
  });

  describe('listOpenIssues()', () => {
    it('Issue 一覧を正しくパースする', async () => {
      const mockIssues = [
        {
          number: 1,
          title: 'Bug report',
          body: 'There is a bug',
          url: 'https://github.com/owner/repo/issues/1',
          labels: [{ name: 'bug' }],
          updatedAt: '2024-01-01T00:00:00Z',
        },
        {
          number: 2,
          title: 'Feature request',
          body: 'Add new feature',
          url: 'https://github.com/owner/repo/issues/2',
          labels: ['enhancement'],
          updatedAt: '2024-01-02T00:00:00Z',
        },
      ];
      vi.spyOn(agent as any, 'exec').mockResolvedValue(JSON.stringify(mockIssues));

      const result = await agent.listOpenIssues('owner', 'repo');

      expect(result).toHaveLength(2);
      expect(result[0].number).toBe(1);
      expect(result[0].title).toBe('Bug report');
      expect(result[0].labels).toEqual(['bug']);
      expect(result[1].labels).toEqual(['enhancement']);
    });

    it('必須フィールド (number, title, url) が欠けている Issue は除外される', async () => {
      const mockIssues = [
        { number: 1, title: 'Valid', url: 'https://github.com/owner/repo/issues/1', body: '', labels: [] },
        { title: 'No number', url: 'https://example.com', body: '', labels: [] },
        { number: 3, url: 'https://github.com/owner/repo/issues/3', body: '', labels: [] },
      ];
      vi.spyOn(agent as any, 'exec').mockResolvedValue(JSON.stringify(mockIssues));

      const result = await agent.listOpenIssues('owner', 'repo');

      expect(result).toHaveLength(1);
      expect(result[0].number).toBe(1);
    });
  });

  describe('getIssue()', () => {
    it('単一 Issue を正しくパースする', async () => {
      const mockIssue = {
        number: 5,
        title: 'Test issue',
        body: 'Issue body',
        url: 'https://github.com/owner/repo/issues/5',
        labels: [],
      };
      vi.spyOn(agent as any, 'exec').mockResolvedValue(JSON.stringify(mockIssue));

      const result = await agent.getIssue('owner', 'repo', 5);

      expect(result.number).toBe(5);
      expect(result.title).toBe('Test issue');
      expect(result.body).toBe('Issue body');
    });

    it('パースに失敗したとき例外をスローする', async () => {
      vi.spyOn(agent as any, 'exec').mockResolvedValue(JSON.stringify({ title: 'No number' }));

      await expect(agent.getIssue('owner', 'repo', 5)).rejects.toThrow('Failed to parse issue');
    });
  });

  describe('createIssue()', () => {
    it('Issue URL から issueNumber と issueUrl を正しくパースする', async () => {
      vi.spyOn(agent as any, 'exec').mockResolvedValue(
        'https://github.com/owner/repo/issues/99\n'
      );

      const result = await agent.createIssue('owner', 'repo', 'Issue title', 'Issue body');

      expect(result.issueNumber).toBe(99);
      expect(result.issueUrl).toBe('https://github.com/owner/repo/issues/99');
    });

    it('URL が含まれない出力では例外をスローする', async () => {
      vi.spyOn(agent as any, 'exec').mockResolvedValue('no url here\n');

      await expect(
        agent.createIssue('owner', 'repo', 'title', 'body')
      ).rejects.toThrow('Failed to parse issue URL');
    });
  });

  describe('exec エラーハンドリング', () => {
    it('execFileAsync が失敗したとき意味のあるエラーメッセージをスローする', async () => {
      const { execFile } = await import('child_process');
      const errorMock = Object.assign(new Error('command not found'), {
        stderr: 'gh: command not found',
        stdout: '',
      });

      vi.spyOn(agent as any, 'exec').mockRejectedValue(
        new Error('gh pr create failed: gh: command not found')
      );

      await expect(
        agent.createPr('owner', 'repo', 'branch', 'title', 'body')
      ).rejects.toThrow('failed');
    });
  });
});
