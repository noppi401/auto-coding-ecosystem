import { BaseAgent } from './base-agent.js';
import { Task, ReviewComment } from '../state/types.js';
import { logger } from '../utils/logger.js';
import { applyHunks } from '../utils/hunks.js';

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

    // hunk は行番号で位置を指定するため、実ファイルには 1 始まりの行番号を付けて渡す
    // （pr.diff は hunk の対象ではないのでそのまま）。番号はファイル内容の一部ではない。
    const withLineNumbers = (text: string) =>
      text.split('\n').map((line, i) => `${i + 1}| ${line}`).join('\n');
    // hunk は行番号で全体の位置を指すため、ファイルの先頭しか見せないと見えない部分を壊す。
    // 実ファイルは全文（暴走防止の上限のみ）を渡し、pr.diff は従来どおり先頭だけ。
    const fileMax = Number(process.env.FIX_CURRENT_FILE_MAX_CHARS || '60000');
    const currentFilesText = Object.entries(currentFiles)
      .map(([path, content]) => {
        const body = content.substring(0, path === 'pr.diff' ? 8000 : fileMax);
        return `FILE: ${path}\n${path === 'pr.diff' ? body : withLineNumbers(body)}`;
      })
      .join('\n\n');

    const prompt = `Fix the code based on the review comments.

TASK: ${task.title}
SUMMARY: ${task.summary}

CURRENT FILES (each line is prefixed with "N| " where N is its 1-indexed line number; the prefix is NOT part of the file, never include it in newLines):
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

  private normalizeFixOutput(data: any, currentFiles: { [path: string]: string }): FixOutput {
    const files = (data.files || []).map((file: any) => {
      const path: string = file.path;

      if (Array.isArray(file.hunks) && file.hunks.length > 0) {
        const existing = currentFiles[path] ?? '';
        const content = applyHunks(existing, file.hunks as FixHunk[]);
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
