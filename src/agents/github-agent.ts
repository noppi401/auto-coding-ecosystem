import { execFile } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import { dirname, join, resolve, sep } from 'path';
import { homedir } from 'os';
import { ReviewComment, SourceIssue } from '../state/types.js';
import { logger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);

interface PrInfo {
  prNumber: number;
  prUrl: string;
}

interface IssueInfo {
  issueNumber: number;
  issueUrl: string;
}

interface WorktreeSyncInfo {
  path: string;
  branch: string;
  commit: string;
}

type WorktreeSyncTarget = '__context' | 'ECOSYSTEM_PRODUCT_WORKTREE' | 'Products checkout' | 'checkout';

interface FileOp {
  path: string;
  content: string;
}

export class GitHubAgent {
  private workspaceRoot = process.env.ECOSYSTEM_WORKSPACE || '.ecosystem/worktrees';

  async createRepo(owner: string, repo: string): Promise<void> {
    logger.info('GitHubAgent creating repository via gh CLI');
    await this.exec('gh', ['repo', 'create', `${owner}/${repo}`, '--public', '--add-readme']);
  }

  async getRepositoryContext(owner: string, repo: string): Promise<string> {
    const baseBranch = process.env.BASE_BRANCH || 'main';
    const worktree = this.getWorktreePath(owner, repo, '__context');

    await fs.mkdir(dirname(worktree), { recursive: true });

    if (!(await this.pathExists(join(worktree, '.git')))) {
      await this.cloneRepo(owner, repo, worktree);
    }

    await this.exec('git', ['fetch', 'origin', baseBranch], worktree);
    await this.exec('git', ['checkout', '-B', baseBranch, `origin/${baseBranch}`], worktree);

    const files = (await this.exec('git', ['ls-files'], worktree))
      .split(/\r?\n/)
      .map((file) => file.trim())
      .filter(Boolean)
      .filter((file) => !this.shouldSkipContextFile(file));

    const maxFiles = Number(process.env.REPO_CONTEXT_MAX_FILES || '80');
    const maxChars = Number(process.env.REPO_CONTEXT_MAX_CHARS || '40000');
    const selectedFiles = files.slice(0, maxFiles);
    const sections: string[] = [
      `Repository: ${owner}/${repo}`,
      `Base branch: ${baseBranch}`,
      '',
      'Tracked files:',
      ...files.slice(0, maxFiles).map((file) => `- ${file}`),
    ];

    if (files.length > maxFiles) {
      sections.push(`- ... ${files.length - maxFiles} more files omitted`);
    }

    sections.push('', 'Key file excerpts:');

    let usedChars = sections.join('\n').length;
    for (const file of selectedFiles) {
      if (!this.isTextContextFile(file)) {
        continue;
      }

      const fullPath = join(worktree, file);
      const content = await fs.readFile(fullPath, 'utf-8').catch(() => '');
      if (!content) {
        continue;
      }

      const excerpt = content.slice(0, Number(process.env.REPO_CONTEXT_FILE_MAX_CHARS || '4000'));
      const block = `\n--- FILE: ${file} ---\n${excerpt}`;
      if (usedChars + block.length > maxChars) {
        sections.push('\n--- context truncated ---');
        break;
      }

      sections.push(block);
      usedChars += block.length;
    }

    return sections.join('\n');
  }

  async createBranch(owner: string, repo: string, branch: string): Promise<void> {
    const worktree = this.getWorktreePath(owner, repo, branch);
    const baseBranch = process.env.BASE_BRANCH || 'main';

    await fs.mkdir(dirname(worktree), { recursive: true });

    if (!(await this.pathExists(join(worktree, '.git')))) {
      await this.cloneRepo(owner, repo, worktree);
    }

    await this.ensureBaseBranch(owner, repo, worktree, baseBranch);
    const remoteBranch = await this.execAllowFailure(
      'git',
      ['ls-remote', '--heads', 'origin', branch],
      worktree
    );

    if (remoteBranch?.trim()) {
      await this.exec('git', ['fetch', 'origin', branch], worktree);
      await this.exec('git', ['checkout', '-B', branch, `origin/${branch}`], worktree);
      return;
    }

    await this.exec('git', ['fetch', 'origin', baseBranch], worktree);
    await this.exec('git', ['checkout', '-B', branch, `origin/${baseBranch}`], worktree);
    await this.exec('git', ['push', '-u', 'origin', branch], worktree);
  }

  async commitFiles(
    owner: string,
    repo: string,
    branch: string,
    files: FileOp[],
    commitMessage: string
  ): Promise<boolean> {
    const worktree = this.getWorktreePath(owner, repo, branch);

    if (!(await this.pathExists(join(worktree, '.git')))) {
      await this.createBranch(owner, repo, branch);
    }

    for (const file of files) {
      const filePath = this.resolveInWorktree(worktree, file.path);
      await fs.mkdir(dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, file.content);
    }

    // 書き込んだファイルだけをステージする（ビルドゲートが作る node_modules 等を含めない）
    await this.exec('git', ['add', '--', ...files.map((file) => file.path)], worktree);
    const status = await this.exec('git', ['status', '--porcelain'], worktree);
    if (!status.trim()) {
      logger.info('No file changes to commit', branch);
      return false;
    }

    await this.exec('git', ['commit', '-m', commitMessage], worktree);
    await this.exec('git', ['push', 'origin', branch], worktree);
    return true;
  }

  async readFiles(
    owner: string,
    repo: string,
    branch: string,
    paths: string[]
  ): Promise<Record<string, string>> {
    const worktree = this.getWorktreePath(owner, repo, branch);
    const files: Record<string, string> = {};

    for (const path of paths) {
      const fullPath = this.resolveInWorktree(worktree, path);
      const content = await fs.readFile(fullPath, 'utf-8').catch(() => null);
      if (content !== null) {
        files[path] = content;
      }
    }

    return files;
  }

  async createPr(
    owner: string,
    repo: string,
    branch: string,
    title: string,
    body: string
  ): Promise<PrInfo> {
    const baseBranch = process.env.BASE_BRANCH || 'main';
    let result: string;

    try {
      result = await this.exec('gh', [
        'pr',
        'create',
        '--repo',
        `${owner}/${repo}`,
        '--title',
        title,
        '--body',
        body,
        '--base',
        baseBranch,
        '--head',
        branch,
      ]);
    } catch (err) {
      const existingPr = await this.findOpenPrForBranch(owner, repo, branch);
      if (existingPr) {
        logger.warn(
          'PR already exists for branch; reusing existing PR',
          `#${existingPr.prNumber} ${branch}`
        );
        return existingPr;
      }
      throw err;
    }

    const prUrl = result.trim().split(/\r?\n/).find((line) => line.startsWith('http'));
    const match = prUrl?.match(/\/pull\/(\d+)/);
    if (!prUrl || !match) {
      throw new Error(`Failed to parse PR URL from gh output: ${result}`);
    }

    return {
      prNumber: Number(match[1]),
      prUrl,
    };
  }

  async findOpenPrForBranch(
    owner: string,
    repo: string,
    branch: string
  ): Promise<PrInfo | null> {
    const result = await this.execAllowFailure('gh', [
      'pr',
      'list',
      '--repo',
      `${owner}/${repo}`,
      '--head',
      branch,
      '--state',
      'open',
      '--json',
      'number,url',
      '--limit',
      '1',
    ]);

    if (!result?.trim()) {
      return null;
    }

    const prs = JSON.parse(result) as Array<{ number?: number; url?: string }>;
    const pr = prs[0];
    if (!pr?.number || !pr.url) {
      return null;
    }

    return {
      prNumber: pr.number,
      prUrl: pr.url,
    };
  }

  async createIssue(
    owner: string,
    repo: string,
    title: string,
    body: string
  ): Promise<IssueInfo> {
    const result = await this.exec('gh', [
      'issue',
      'create',
      '--repo',
      `${owner}/${repo}`,
      '--title',
      title,
      '--body',
      body,
    ]);

    const issueUrl = result.trim().split(/\r?\n/).find((line) => line.startsWith('http'));
    const match = issueUrl?.match(/\/issues\/(\d+)/);
    if (!issueUrl || !match) {
      throw new Error(`Failed to parse issue URL from gh output: ${result}`);
    }

    return {
      issueNumber: Number(match[1]),
      issueUrl,
    };
  }

  async listOpenIssues(owner: string, repo: string, limit: number = 30): Promise<SourceIssue[]> {
    const result = await this.exec('gh', [
      'issue',
      'list',
      '--repo',
      `${owner}/${repo}`,
      '--state',
      'open',
      '--json',
      'number,title,body,url,labels,updatedAt',
      '--limit',
      String(limit),
    ]);

    return this.parseIssues(result);
  }

  async getIssue(owner: string, repo: string, issueNumber: number): Promise<SourceIssue> {
    const result = await this.exec('gh', [
      'issue',
      'view',
      String(issueNumber),
      '--repo',
      `${owner}/${repo}`,
      '--json',
      'number,title,body,url,labels,updatedAt',
    ]);

    const issue = this.parseIssue(JSON.parse(result));
    if (!issue) {
      throw new Error(`Failed to parse issue #${issueNumber}`);
    }

    return issue;
  }

  async commentIssue(
    owner: string,
    repo: string,
    issueNumber: number,
    body: string
  ): Promise<void> {
    await this.exec('gh', [
      'issue',
      'comment',
      String(issueNumber),
      '--repo',
      `${owner}/${repo}`,
      '--body',
      body,
    ]);
  }

  async closeIssue(
    owner: string,
    repo: string,
    issueNumber: number,
    comment?: string
  ): Promise<void> {
    const args = [
      'issue',
      'close',
      String(issueNumber),
      '--repo',
      `${owner}/${repo}`,
    ];

    if (comment) {
      args.push('--comment', comment);
    }

    await this.exec('gh', args);
  }

  async runCommandInWorktree(
    owner: string,
    repo: string,
    branch: string,
    command: string,
    args: string[],
    timeoutMs: number = 60000
  ): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
    const worktree = this.getWorktreePath(owner, repo, branch);
    if (!(await this.pathExists(worktree))) {
      return { stdout: '', stderr: `Worktree not found: ${worktree}`, exitCode: -1, timedOut: false };
    }

    try {
      const resolvedCommand = this.resolvePlatformCommand(command, args);
      const { stdout, stderr } = await execFileAsync(resolvedCommand.command, resolvedCommand.args, {
        cwd: worktree,
        env: process.env,
        maxBuffer: 5 * 1024 * 1024,
        timeout: timeoutMs,
      });
      return { stdout: stdout || '', stderr: stderr || '', exitCode: 0, timedOut: false };
    } catch (err: any) {
      return {
        stdout: err?.stdout || '',
        stderr: err?.stderr || err?.message || '',
        exitCode: typeof err?.code === 'number' ? err.code : 1,
        timedOut: Boolean(err?.killed),
      };
    }
  }

  async pathExistsInWorktree(owner: string, repo: string, branch: string, relativePath: string): Promise<boolean> {
    const worktree = this.getWorktreePath(owner, repo, branch);
    return this.pathExists(join(worktree, relativePath));
  }

  private resolvePlatformCommand(command: string, args: string[]): { command: string; args: string[] } {
    if (
      process.platform !== 'win32' ||
      command.endsWith('.exe') ||
      !['npm', 'npx', 'pnpm', 'yarn', 'npm.cmd', 'npx.cmd', 'pnpm.cmd', 'yarn.cmd'].includes(command)
    ) {
      return { command, args };
    }

    const cmdCommand = command.endsWith('.cmd') ? command : `${command}.cmd`;

    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', cmdCommand, ...args],
    };
  }

  async getPrDiff(owner: string, repo: string, prNumber: number): Promise<string> {
    return await this.exec('gh', [
      'pr',
      'diff',
      String(prNumber),
      '--repo',
      `${owner}/${repo}`,
    ]);
  }

  async postReviewComments(
    owner: string,
    repo: string,
    prNumber: number,
    comments: ReviewComment[]
  ): Promise<void> {
    const body = comments
      .map(
        (comment) =>
          `- ${comment.severity.toUpperCase()}: ${comment.path}:${comment.line}\n  ${comment.body}`
      )
      .join('\n\n');

    await this.commentPr(
      owner,
      repo,
      prNumber,
      `Automated review comments:\n\n${body}`
    );
  }

  async commentPr(
    owner: string,
    repo: string,
    prNumber: number,
    body: string
  ): Promise<void> {
    await this.exec('gh', [
      'pr',
      'comment',
      String(prNumber),
      '--repo',
      `${owner}/${repo}`,
      '--body',
      body,
    ]);
  }

  async approvePr(owner: string, repo: string, prNumber: number, summary: string): Promise<void> {
    try {
      await this.exec('gh', [
        'pr',
        'review',
        String(prNumber),
        '--repo',
        `${owner}/${repo}`,
        '--approve',
        '--body',
        summary,
      ]);
    } catch (err) {
      if (!this.isOwnPullRequestReviewError(err)) {
        throw err;
      }

      logger.warn(
        'Cannot formally approve own PR; posting approval summary as comment',
        `PR #${prNumber}`
      );
      await this.commentPr(owner, repo, prNumber, `Automated approval:\n\n${summary}`);
    }
  }

  async requestChanges(
    owner: string,
    repo: string,
    prNumber: number,
    summary: string
  ): Promise<void> {
    try {
      await this.exec('gh', [
        'pr',
        'review',
        String(prNumber),
        '--repo',
        `${owner}/${repo}`,
        '--request-changes',
        '--body',
        summary,
      ]);
    } catch (err) {
      if (!this.isOwnPullRequestReviewError(err)) {
        throw err;
      }

      logger.warn(
        'Cannot formally request changes on own PR; posting summary as comment',
        `PR #${prNumber}`
      );
      await this.commentPr(
        owner,
        repo,
        prNumber,
        `Automated review did not approve this PR:\n\n${summary}`
      );
    }
  }

  async mergePr(owner: string, repo: string, prNumber: number): Promise<void> {
    await this.exec('gh', [
      'pr',
      'merge',
      String(prNumber),
      '--repo',
      `${owner}/${repo}`,
      '--squash',
      '--delete-branch',
    ]);
  }

  async syncContextWorktree(owner: string, repo: string): Promise<WorktreeSyncInfo> {
    const baseBranch = process.env.BASE_BRANCH || 'main';
    const worktree = this.getWorktreePath(owner, repo, '__context');
    return this.syncExistingCheckout(owner, repo, worktree, baseBranch, '__context');
  }

  async syncProductWorktree(owner: string, repo: string): Promise<WorktreeSyncInfo | null> {
    const baseBranch = process.env.BASE_BRANCH || 'main';
    const explicitPath = process.env.ECOSYSTEM_PRODUCT_WORKTREE;
    const productRoot = process.env.ECOSYSTEM_PRODUCT_ROOT || join(homedir(), 'Documents', 'Products');
    const checkoutPath = explicitPath || join(productRoot, repo);
    const strict = Boolean(explicitPath);

    if (!(await this.pathExists(checkoutPath))) {
      if (strict) {
        throw new Error(`Configured product worktree does not exist: ${checkoutPath}`);
      }
      logger.info('Product worktree not found; skipping synchronization', checkoutPath);
      return null;
    }

    return this.syncExistingCheckout(
      owner,
      repo,
      checkoutPath,
      baseBranch,
      explicitPath ? 'ECOSYSTEM_PRODUCT_WORKTREE' : 'Products checkout'
    );
  }

  private async syncExistingCheckout(
    owner: string,
    repo: string,
    checkoutPath: string,
    baseBranch: string,
    target: WorktreeSyncTarget = 'checkout'
  ): Promise<WorktreeSyncInfo> {
    const worktree = resolve(checkoutPath);

    await fs.mkdir(dirname(worktree), { recursive: true });

    if (!(await this.pathExists(join(worktree, '.git')))) {
      await this.cloneRepo(owner, repo, worktree);
    }

    const statusBeforeSync = await this.exec('git', ['status', '--porcelain'], worktree);
    if (statusBeforeSync.trim()) {
      throw this.buildDirtyWorktreeError(
        'Worktree has uncommitted changes and cannot be synchronized safely',
        target,
        worktree,
        statusBeforeSync
      );
    }

    await this.exec('git', ['fetch', 'origin', baseBranch], worktree);
    await this.exec('git', ['checkout', '-B', baseBranch, `origin/${baseBranch}`], worktree);
    await this.exec('git', ['reset', '--hard', `origin/${baseBranch}`], worktree);

    const statusAfterSync = await this.exec('git', ['status', '--porcelain'], worktree);
    if (statusAfterSync.trim()) {
      throw this.buildDirtyWorktreeError(
        'Worktree is dirty after synchronization',
        target,
        worktree,
        statusAfterSync
      );
    }

    const localCommit = (await this.exec('git', ['rev-parse', 'HEAD'], worktree)).trim();
    const remoteCommit = (await this.exec('git', ['rev-parse', `origin/${baseBranch}`], worktree)).trim();
    if (localCommit !== remoteCommit) {
      throw new Error(
        `Worktree is not at origin/${baseBranch}: ${localCommit} != ${remoteCommit}`
      );
    }

    return {
      path: worktree,
      branch: baseBranch,
      commit: localCommit,
    };
  }

  private buildDirtyWorktreeError(
    reason: string,
    target: WorktreeSyncTarget,
    worktree: string,
    porcelainStatus: string
  ): Error {
    const statusLines = porcelainStatus
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter(Boolean);
    const inlineStatus = statusLines.slice(0, 3).join(', ');
    const visibleLines = statusLines.slice(0, 20).map((line) => `- ${line}`);
    if (statusLines.length > visibleLines.length) {
      visibleLines.push(`- ... ${statusLines.length - visibleLines.length} more file(s)`);
    }

    logger.warn('Worktree synchronization stopped because worktree is dirty', {
      target,
      path: worktree,
      status: inlineStatus,
    });

    return new Error([
      `${reason} in ${target}: ${inlineStatus}`,
      `Path: ${worktree}`,
      '',
      'git status --porcelain:',
      ...visibleLines,
      '',
      'Recovery:',
      '- Commit or stash the listed changes, then retry.',
      '- Move local-only edits out of this checkout if they should not be synchronized.',
      '- If this is the wrong product checkout, update ECOSYSTEM_PRODUCT_WORKTREE or ECOSYSTEM_PRODUCT_ROOT.',
      'ACE did not run destructive cleanup for these dirty files.',
    ].join('\n'));
  }

  private getWorktreePath(owner: string, repo: string, branch: string): string {
    const safeOwner = owner.replace(/[^a-zA-Z0-9._-]/g, '-');
    const safeRepo = repo.replace(/[^a-zA-Z0-9._-]/g, '-');
    const safeBranch = branch.replace(/[^a-zA-Z0-9._-]/g, '-');
    return join(process.cwd(), this.workspaceRoot, safeOwner, safeRepo, safeBranch);
  }

  private resolveInWorktree(worktree: string, relativePath: string): string {
    const root = resolve(worktree);
    const fullPath = resolve(root, relativePath);
    if (!fullPath.startsWith(root + sep)) {
      throw new Error(`Refusing path outside worktree: ${relativePath}`);
    }
    return fullPath;
  }

  private async pathExists(path: string): Promise<boolean> {
    return fs.stat(path).then(() => true).catch(() => false);
  }

  private shouldSkipContextFile(file: string): boolean {
    return /(^|\/)(node_modules|dist|build|coverage|\.next|\.nuxt|vendor|target)\//.test(file) ||
      /\.(png|jpg|jpeg|gif|webp|ico|pdf|zip|gz|tar|mp4|mp3|woff2?|ttf|eot)$/i.test(file);
  }

  private isTextContextFile(file: string): boolean {
    return /(^|\/)(README|package\.json|tsconfig\.json|vite\.config|next\.config|src\/|app\/|pages\/|components\/|lib\/|server\/|test|tests|__tests__)/i.test(file) ||
      /\.(ts|tsx|js|jsx|json|md|yml|yaml|css|scss|html)$/i.test(file);
  }

  private async ensureBaseBranch(
    owner: string,
    repo: string,
    worktree: string,
    baseBranch: string
  ): Promise<void> {
    const remoteRef = await this.execAllowFailure(
      'git',
      ['ls-remote', '--heads', 'origin', baseBranch],
      worktree
    );

    if (remoteRef?.trim()) {
      return;
    }

    logger.warn(
      'Base branch does not exist; creating initial commit',
      `${owner}/${repo}:${baseBranch}`
    );

    await this.ensureGitIdentity(worktree);
    await this.execAllowFailure('git', ['checkout', '--orphan', baseBranch], worktree);
    await this.execAllowFailure('git', ['checkout', '-B', baseBranch], worktree);

    const readmePath = join(worktree, 'README.md');
    if (!(await this.pathExists(readmePath))) {
      await fs.writeFile(
        readmePath,
        `# ${repo}\n\nInitial repository scaffold for the autonomous coding pipeline.\n`
      );
    }

    await this.exec('git', ['add', 'README.md'], worktree);
    const status = await this.exec('git', ['status', '--porcelain'], worktree);
    if (status.trim()) {
      await this.exec('git', ['commit', '-m', 'chore: initialize repository'], worktree);
    }
    await this.exec('git', ['push', '-u', 'origin', baseBranch], worktree);
  }

  private async ensureGitIdentity(worktree: string): Promise<void> {
    const email = await this.execAllowFailure('git', ['config', 'user.email'], worktree);
    if (!email?.trim()) {
      await this.exec('git', ['config', 'user.email', process.env.GIT_AUTHOR_EMAIL || 'auto-coding@example.local'], worktree);
    }

    const name = await this.execAllowFailure('git', ['config', 'user.name'], worktree);
    if (!name?.trim()) {
      await this.exec('git', ['config', 'user.name', process.env.GIT_AUTHOR_NAME || 'Auto Coding Ecosystem'], worktree);
    }
  }

  private async cloneRepo(owner: string, repo: string, dest: string): Promise<void> {
    const token = (await this.exec('gh', ['auth', 'token'])).trim();
    await this.exec('git', [
      'clone',
      `https://x-access-token:${token}@github.com/${owner}/${repo}.git`,
      dest,
    ]);
  }

  private async execAllowFailure(
    command: string,
    args: string[],
    cwd?: string
  ): Promise<string | null> {
    try {
      return await this.exec(command, args, cwd);
    } catch {
      return null;
    }
  }

  private isOwnPullRequestReviewError(err: unknown): boolean {
    const message = String(err).toLowerCase();
    return (
      message.includes('can not approve your own pull request') ||
      message.includes('can not request changes on your own pull request') ||
      message.includes('cannot approve your own pull request') ||
      message.includes('cannot request changes on your own pull request')
    );
  }

  private async exec(command: string, args: string[], cwd?: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync(command, args, {
        cwd,
        env: process.env,
        maxBuffer: 20 * 1024 * 1024,
      });
      return stdout;
    } catch (err: any) {
      const stderr = err?.stderr ? String(err.stderr) : '';
      const stdout = err?.stdout ? String(err.stdout) : '';
      const message = `${command} ${args.join(' ')} failed: ${stderr || stdout || err.message}`;
      throw new Error(message.replace(/x-access-token:[^@\s]+@/g, 'x-access-token:***@'));
    }
  }

  private parseIssues(result: string): SourceIssue[] {
    const issues = JSON.parse(result) as unknown[];
    return issues.map((issue) => this.parseIssue(issue)).filter((issue): issue is SourceIssue => Boolean(issue));
  }

  private parseIssue(value: unknown): SourceIssue | null {
    const issue = value as {
      number?: number;
      title?: string;
      body?: string;
      url?: string;
      labels?: Array<{ name?: string } | string>;
      updatedAt?: string;
    };

    if (!issue?.number || !issue.title || !issue.url) {
      return null;
    }

    return {
      number: issue.number,
      title: issue.title,
      body: issue.body || '',
      url: issue.url,
      labels: (issue.labels || [])
        .map((label) => typeof label === 'string' ? label : label.name)
        .filter((label): label is string => Boolean(label)),
      updatedAt: issue.updatedAt,
    };
  }
}
