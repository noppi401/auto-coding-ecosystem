import { BaseAgent } from './base-agent.js';
import { logger } from '../utils/logger.js';
import { t } from '../utils/i18n.js';

export class DesignAgent extends BaseAgent {
  constructor() {
    super('design.md', 'DesignAgent');
  }

  async generateDesign(
    requirementsDoc: string,
    repositoryContext?: string
  ): Promise<string> {
    await this.loadSystemPrompt();

    logger.section('DesignAgent: Generating design');

    const prompt = `Based on the following requirements, please create a detailed architectural design document.

${repositoryContext ? `Existing Repository Context:\n${repositoryContext}\n\n` : ''}REQUIREMENTS:
${requirementsDoc}

${repositoryContext ? 'Design the change to fit the existing repository structure. Prefer modifying existing modules over inventing parallel architecture.' : ''}`;

    const result = await this.invoke(prompt, 8000);

    logger.info('DesignAgent completed');
    return result;
  }

  async reviseDesign(
    currentDoc: string,
    issues: string[],
    recommendations: string[],
    requirementsDoc: string
  ): Promise<string> {
    await this.loadSystemPrompt();

    logger.section(t('DesignAgent: 指摘事項に基づき設計書を修正中', 'DesignAgent: revising the design based on the findings'));

    const issueLines = issues.map((i) => `- ${i}`).join('\n');
    const recLines = recommendations.map((r) => `- ${r}`).join('\n');

    const prompt = t(`## 要件定義書（参照用）
${requirementsDoc}

## 現在の設計書（修正前）
${currentDoc}

## 検証エージェントによる指摘事項
${issueLines}

## 改善提案
${recLines}

上記の指摘事項と改善提案をすべて反映して設計書を修正してください。
修正後の設計書のみをMarkdown形式で返してください。`, `## Requirements (for reference)
${requirementsDoc}

## Current design (before revision)
${currentDoc}

## Findings from the validation agent
${issueLines}

## Recommendations
${recLines}

Revise the design to address every finding and recommendation above.
Return only the revised design, in Markdown.`);

    const result = await this.invoke(prompt, 8000);

    logger.info(t('DesignAgent: 修正完了', 'DesignAgent: revision completed'));
    return result;
  }
}
