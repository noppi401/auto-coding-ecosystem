import { BaseAgent } from './base-agent.js';
import { Task, ReviewComment } from '../state/types.js';
import { logger } from '../utils/logger.js';

export interface FixOutput {
  files: Array<{ path: string; content: string }>;
  commitMessage: string;
  fixSummary: string;
}

interface FixHunk {
  startLine: number;
  endLine: number;
  newLines: string[];
}


export class FixAgent extends BaseAgent {
  constructor() {
    super('fix.md', 'FixAgent');
  }

  async fixCode(
    task: Task,
    reviewComments: ReviewComment[],
    currentFiles: { [path: string]: string }
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
          `FILE: ${path}\n${content.substring(0, 8000)}`
      )
      .join('\n\n');

    const prompt = `Fix the code based on the review comments.

TASK: ${task.title}
SUMMARY: ${task.summary}

CURRENT FILES (with 1-indexed line numbers):
${currentFilesText}

REVIEW COMMENTS TO ADDRESS:
${commentsText}

Return ONLY valid JSON — no markdown, no explanations.
To keep output small, return ONLY the changed line ranges using hunks, not full file content.

Format:
{
  "files": [
    {
      "path": "src/file.ts",
      "hunks": [
        {
          "startLine": 10,
          "endLine": 15,
          "newLines": ["replacement line 1", "replacement line 2"]
        }
      ]
    }
  ],
  "commitMessage": "fix: ...",
  "fixSummary": "..."
}

Rules:
- startLine and endLine are 1-indexed and inclusive.
- newLines replaces lines startLine through endLine entirely.
- To insert without deleting, set endLine = startLine - 1.
- For a brand-new file not listed above, omit "hunks" and use top-level "newLines" instead.
- Multiple hunks per file are allowed; list them in ascending startLine order.
- Each string in newLines is one source line — no JSON escape tricks needed, just write the line.`;

    let result = await this.invoke(prompt, 16000);
    let fixOutput: FixOutput;
    try {
      fixOutput = this.parseFixFromResponse(result, currentFiles);
      if (fixOutput.files.length === 0) {
        throw new Error('FixAgent returned an empty files array.');
      }
    } catch (err) {
      logger.warn('FixAgent returned invalid or empty JSON; retrying with stricter output instructions', String(err));
      result = await this.invoke(
        [
          'Your previous response was invalid or contained no file changes.',
          'Return ONLY one valid JSON object matching the hunk format described below.',
          'Do not include markdown or explanations.',
          prompt,
        ].join('\n\n'),
        16000
      );
      fixOutput = this.parseFixFromResponse(result, currentFiles);
    }

    logger.info('FixAgent completed', {
      fileCount: fixOutput.files.length,
    });

    return fixOutput;
  }

  parseFixFromResponse(response: string, currentFiles: { [path: string]: string }): FixOutput {
    try {
      const data = this.robustJsonParse(response);
      return this.normalizeFixOutput(data, currentFiles);
    } catch (err) {
      logger.error('Failed to parse fix output', err);
      throw err;
    }
  }

  private applyHunks(original: string, hunks: FixHunk[]): string {
    const lines = original.split('\n');
    // Apply in reverse order so earlier line numbers stay valid
    const sorted = [...hunks].sort((a, b) => b.startLine - a.startLine);
    for (const hunk of sorted) {
      const start = Math.max(0, hunk.startLine - 1);
      const deleteCount = Math.max(0, hunk.endLine - hunk.startLine + 1);
      lines.splice(start, deleteCount, ...hunk.newLines);
    }
    return lines.join('\n');
  }

  private normalizeFixOutput(data: any, currentFiles: { [path: string]: string }): FixOutput {
    const files = (data.files || []).map((file: any) => {
      const path: string = file.path;

      if (Array.isArray(file.hunks) && file.hunks.length > 0) {
        const existing = currentFiles[path] ?? '';
        const content = this.applyHunks(existing, file.hunks as FixHunk[]);
        return { path, content };
      }

      // New file or fallback: top-level newLines array
      if (Array.isArray(file.newLines)) {
        return { path, content: (file.newLines as string[]).join('\n') };
      }

      // Legacy fallback: base64 or raw content from older prompts
      if (file.contentBase64) {
        return { path, content: Buffer.from(file.contentBase64, 'base64').toString('utf-8') };
      }
      if (typeof file.content === 'string') {
        return { path, content: file.content };
      }

      return { path, content: '' };
    });

    return {
      files,
      commitMessage: data.commitMessage || data.commit_message || 'fix: address review feedback',
      fixSummary: data.fixSummary || data.fix_summary || '',
    };
  }
}
