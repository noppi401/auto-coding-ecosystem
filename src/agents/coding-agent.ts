import { BaseAgent } from './base-agent.js';
import { Task } from '../state/types.js';
import { logger } from '../utils/logger.js';

export interface CodeOutput {
  files: Array<{ path: string; content: string; contentBase64?: string }>;
  commitMessage: string;
  prTitle: string;
  prBody: string;
}

export class CodingAgent extends BaseAgent {
  constructor() {
    super('coding.md', 'CodingAgent');
  }

  async generateCode(
    task: Task,
    requirementsDoc: string,
    designDoc: string,
    currentFiles: Record<string, string> = {}
  ): Promise<CodeOutput> {
    await this.loadSystemPrompt();

    logger.section(`CodingAgent: Generating code for "${task.title}"`);

    const prompt = `Generate code for the following task:

TASK: ${task.title}
SUMMARY: ${task.summary}

REQUIREMENTS (excerpt):
${requirementsDoc.substring(0, 6000)}

DESIGN (excerpt):
${designDoc.substring(0, 4000)}

${Object.keys(currentFiles).length > 0 ? `CURRENT TARGET FILES:
${Object.entries(currentFiles)
  .map(([path, content]) => `--- FILE: ${path} ---\n${content}`)
  .join('\n\n')}

` : ''}TARGET FILES:
${task.targetFiles.map((file) => `- ${file}`).join('\n') || '- not specified'}

Please generate complete, production-ready code. Return ONLY valid JSON (no markdown, no explanations).
To avoid broken JSON escaping, put each file body in contentBase64 as UTF-8 base64. Do not include raw file content.
Use camelCase keys exactly as shown:
{
  "files": [{"path": "src/file.ts", "contentBase64": "base64-encoded UTF-8 file content"}],
  "commitMessage": "...",
  "prTitle": "...",
  "prBody": "..."
}`;

    let result = await this.invoke(prompt, 16000);
    let codeOutput: CodeOutput;
    try {
      codeOutput = this.parseCodeFromResponse(result);
    } catch (err) {
      logger.warn('CodingAgent returned invalid JSON; retrying with stricter output instructions', String(err));
      result = await this.invoke(
        [
          'Your previous response was not valid JSON.',
          'Return ONLY one valid JSON object.',
          'Use contentBase64 for every file body.',
          'Do not include markdown, explanations, or raw source code strings.',
          prompt,
        ].join('\n\n'),
        16000
      );
      codeOutput = this.parseCodeFromResponse(result);
    }

    logger.info('CodingAgent completed', {
      fileCount: codeOutput.files.length,
    });

    return codeOutput;
  }

  parseCodeFromResponse(response: string): CodeOutput {
    try {
      const jsonMatch = response.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
      const cleanedResponse = jsonMatch ? jsonMatch[1] : response;
      return this.normalizeCodeOutput(JSON.parse(cleanedResponse));
    } catch (err) {
      logger.error('Failed to parse code output', err);
      throw err;
    }
  }

  private normalizeCodeOutput(data: any): CodeOutput {
    return {
      files: (data.files || []).map((file: any) => ({
        path: file.path,
        content: file.contentBase64
          ? Buffer.from(file.contentBase64, 'base64').toString('utf-8')
          : file.content,
        contentBase64: file.contentBase64,
      })),
      commitMessage: data.commitMessage || data.commit_message || 'feat: implement task',
      prTitle: data.prTitle || data.pr_title || 'Implement task',
      prBody: data.prBody || data.pr_body || '',
    };
  }
}
