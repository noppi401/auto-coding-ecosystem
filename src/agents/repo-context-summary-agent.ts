import { BaseAgent } from './base-agent.js';
import { logger } from '../utils/logger.js';
import { t } from '../utils/i18n.js';

/**
 * 既存リポジトリの大きなコンテキストを一度だけ要約するエージェント。
 * 要約を後続の Requirements / Design / TaskDecomp で再利用することで、
 * 同じ巨大コンテキストの重複送信を避けてトークンを削減する（Issue #7）。
 *
 * Planning ルートで動くため、既定では安価なモデル（haiku）が使われる。
 */
export class RepoContextSummaryAgent extends BaseAgent {
  constructor() {
    super('repo-context-summary.md', 'RepoContextSummaryAgent');
  }

  async summarize(repositoryContext: string): Promise<string> {
    await this.loadSystemPrompt();

    logger.section('RepoContextSummaryAgent: Summarizing repository context');

    const maxChars = Number(process.env.REPO_CONTEXT_SUMMARY_INPUT_MAX_CHARS || '40000');
    const prompt = t(
      '次のリポジトリコンテキストを、後続の要件定義・設計・タスク分解で再利用できる簡潔な要約に圧縮してください。\n\nリポジトリコンテキスト:\n',
      'Compress the following repository context into a concise summary that later requirements, design, and task-breakdown steps can reuse.\n\nRepository context:\n'
    ) + repositoryContext.substring(0, maxChars);

    const result = await this.invoke(prompt, 4000);
    logger.info('RepoContextSummaryAgent completed', {
      inputChars: repositoryContext.length,
      summaryChars: result.length,
    });
    return result.trim();
  }
}
