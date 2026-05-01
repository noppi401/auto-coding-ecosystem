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
}
