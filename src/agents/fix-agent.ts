import { BaseAgent } from './base-agent.js';
import { Task, ReviewComment } from '../state/types.js';
import { logger } from '../utils/logger.js';

export interface FixOutput {
  files: Array<{ path: string; content: string; contentBase64?: string }>;
  commitMessage: string;
  fixSummary: string;
}

export class FixAgent extends BaseAgent {
  constructor() {
    super('fix.md', 'FixAgent');
  }

  async fixCode(
    task: Task,
    reviewComments: ReviewComment[],
    currentFiles: { [path: string]: string },
    requirementsDoc: string,
    designDoc: string
  ): Promise<FixOutput> {
    await this.loadSystemPrompt();

    logger.section(`FixAgent: Fixing code for "${task.title}"`);

    const blockingComments = reviewComments.filter(
      (c) => c.severity === 'blocking'
    );
    const suggestionComments = reviewComments.filter(
      (c) => c.severity === 'suggestion'
    );

    let commentsText = 'BLOCKING ISSUES:\n';
    blockingComments.forEach((c) => {
      commentsText += `- ${c.path}:${c.line} - ${c.body}\n`;
    });

    if (suggestionComments.length > 0) {
      commentsText += '\nSUGGESTIONS:\n';
      suggestionComments.forEach((c) => {
        commentsText += `- ${c.path}:${c.line} - ${c.body}\n`;
      });
    }

    const currentFilesText = Object.entries(currentFiles)
      .map(
        ([path, content]) =>
          `FILE: ${path}\n${content.substring(0, 1000)}`
      )
      .join('\n\n');

    const prompt = `Fix the code based on the review comments.

TASK: ${task.title}
SUMMARY: ${task.summary}

REQUIREMENTS:
${requirementsDoc}

DESIGN:
${designDoc}

CURRENT FILES:
${currentFilesText}

REVIEW COMMENTS TO ADDRESS:
${commentsText}

Please fix all blocking issues and address suggestions where reasonable. Return ONLY valid JSON (no markdown, no explanations).
To avoid broken JSON escaping, put each file body in contentBase64 as UTF-8 base64. Do not include raw file content.
Use camelCase keys exactly as shown:
{
  "files": [{"path": "src/file.ts", "contentBase64": "base64-encoded UTF-8 file content"}],
  "commitMessage": "fix: ...",
  "fixSummary": "..."
}`;

    let result = await this.invoke(prompt, 16000);
    let fixOutput: FixOutput;
    try {
      fixOutput = this.parseFixFromResponse(result);
    } catch (err) {
      logger.warn('FixAgent returned invalid JSON; retrying with stricter output instructions', String(err));
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
      fixOutput = this.parseFixFromResponse(result);
    }

    logger.info('FixAgent completed', {
      fileCount: fixOutput.files.length,
    });

    return fixOutput;
  }

  parseFixFromResponse(response: string): FixOutput {
    try {
      const jsonMatch = response.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
      const cleanedResponse = jsonMatch ? jsonMatch[1] : response;
      return this.normalizeFixOutput(JSON.parse(cleanedResponse));
    } catch (err) {
      logger.error('Failed to parse fix output', err);
      throw err;
    }
  }

  private normalizeFixOutput(data: any): FixOutput {
    return {
      files: (data.files || []).map((file: any) => ({
        path: file.path,
        content: file.contentBase64
          ? Buffer.from(file.contentBase64, 'base64').toString('utf-8')
          : file.content,
        contentBase64: file.contentBase64,
      })),
      commitMessage: data.commitMessage || data.commit_message || 'fix: address review feedback',
      fixSummary: data.fixSummary || data.fix_summary || '',
    };
  }
}
