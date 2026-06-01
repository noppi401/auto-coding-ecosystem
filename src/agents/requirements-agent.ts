import { BaseAgent } from './base-agent.js';
import { logger } from '../utils/logger.js';

export class RequirementsAgent extends BaseAgent {
  constructor() {
    super('requirements.md', 'RequirementsAgent');
  }

  async generateRequirements(
    instruction: string,
    repositoryContext?: string
  ): Promise<string> {
    await this.loadSystemPrompt();

    logger.section('RequirementsAgent: Generating requirements');
    logger.info('Input instruction', instruction.substring(0, 100) + '...');

    const prompt = `User Instruction:\n${instruction}

${repositoryContext ? `Existing Repository Context:\n${repositoryContext}\n\n` : ''}Please analyze this instruction and produce a comprehensive requirements document.

${repositoryContext ? 'This is a modification to an existing repository. Infer concrete requirements from the requested change and the repository context. Preserve existing behavior unless the instruction explicitly changes it.' : ''}`;

    const result = await this.invoke(prompt, 8000);

    logger.info('RequirementsAgent completed');
    return result;
  }

  async reviseRequirements(
    currentDoc: string,
    issues: string[],
    recommendations: string[],
    instruction: string
  ): Promise<string> {
    await this.loadSystemPrompt();

    logger.section('RequirementsAgent: 指摘事項に基づき要件定義を修正中');

    const issueLines = issues.map((i) => `- ${i}`).join('\n');
    const recLines = recommendations.map((r) => `- ${r}`).join('\n');

    const prompt = `## 元のユーザーインストラクション
${instruction}

## 現在の要件定義書（修正前）
${currentDoc}

## 検証エージェントによる指摘事項
${issueLines}

## 改善提案
${recLines}

上記の指摘事項と改善提案をすべて反映して要件定義書を修正してください。
修正後の要件定義書のみをMarkdown形式で返してください。`;

    const result = await this.invoke(prompt, 8000);

    logger.info('RequirementsAgent: 修正完了');
    return result;
  }
}
