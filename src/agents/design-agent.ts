import { BaseAgent } from './base-agent.js';
import { logger } from '../utils/logger.js';

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
}
