import { BaseAgent } from './base-agent.js';
import { Task, ReviewResult, ReviewComment } from '../state/types.js';
import { logger } from '../utils/logger.js';

const REQ_DOC_MAX = 4000;
const DESIGN_DOC_MAX = 3000;
const DIFF_MAX = 20000;
const FILE_CONTENTS_MAX = 40000;

// 差分は変更箇所しか見せないため、未変更の行にある定義を「未定義」と誤検知しやすい。
// 変更された既存ファイルの全文を添えて、判定前に確認させる。
function fileContentsSection(fileContents: Record<string, string>): string {
  const entries = Object.entries(fileContents);
  if (entries.length === 0) return '';
  let body = '';
  for (const [path, content] of entries) {
    const chunk = `--- FILE: ${path} ---
${content}

`;
    if (body.length + chunk.length > FILE_CONTENTS_MAX) {
      body += `--- FILE: ${path} --- (omitted: size limit reached)

`;
      continue;
    }
    body += chunk;
  }
  return `FULL CURRENT CONTENT OF MODIFIED FILES (the diff shows only changed hunks; before flagging an identifier as undefined or something as missing, check these full files):
${body}`;
}

function otherTasksSection(otherTasksContext: string): string {
  if (!otherTasksContext) return '';
  return `OTHER PLANNED TASKS (these files are created by separate tasks later; do NOT flag references to them as blocking):
${otherTasksContext}

`;
}

export class ReviewAgent extends BaseAgent {
  constructor() {
    super('review.md', 'ReviewAgent');
  }

  async reviewPr(
    task: Task,
    prDiff: string,
    requirementsDoc: string,
    designDoc: string,
    otherTasksContext: string = '',
    fileContents: Record<string, string> = {}
  ): Promise<ReviewResult> {
    await this.loadSystemPrompt();

    logger.section(`ReviewAgent: Reviewing PR for "${task.title}"`);

    const prompt = `Review the following PR for the task:

TASK: ${task.title}
SUMMARY: ${task.summary}

REQUIREMENTS (excerpt):
${requirementsDoc.substring(0, REQ_DOC_MAX)}

DESIGN (excerpt):
${designDoc.substring(0, DESIGN_DOC_MAX)}

${otherTasksSection(otherTasksContext)}${fileContentsSection(fileContents)}PR DIFF (first ${DIFF_MAX} chars):
${prDiff.substring(0, DIFF_MAX)}

Return ONLY valid JSON (no markdown, no explanations) with this structure:
{
  "approved": boolean,
  "comments": [{"path": "file.ts", "line": 10, "body": "comment", "severity": "blocking" | "suggestion"}],
  "summary": "review summary"
}`;

    let result = await this.invoke(prompt, 8000);
    let reviewResult: ReviewResult;
    try {
      reviewResult = this.parseReviewOrThrow(result);
    } catch (err) {
      logger.warn('ReviewAgent returned invalid JSON; retrying with stricter output instructions', String(err));
      result = await this.invoke(
        [
          'Your previous response was not valid JSON.',
          'Return ONLY one valid JSON object.',
          'Use only plain ASCII characters in string values — no backticks, no template literals, no raw newlines.',
          prompt,
        ].join('\n\n'),
        8000
      );
      reviewResult = this.parseReviewFromResponse(result);
    }

    logger.info('ReviewAgent completed', {
      approved: reviewResult.approved,
      commentCount: reviewResult.comments.length,
    });
    return reviewResult;
  }

  async reReviewAfterFix(
    task: Task,
    updatedPrDiff: string,
    otherTasksContext: string = '',
    fileContents: Record<string, string> = {}
  ): Promise<ReviewResult> {
    await this.loadSystemPrompt();

    logger.section(
      `ReviewAgent: Re-reviewing after fixes (iteration ${task.reviewIteration})`
    );

    const prompt = `The developer has made fixes based on your previous feedback. Please re-review:

TASK: ${task.title}

${otherTasksSection(otherTasksContext)}${fileContentsSection(fileContents)}UPDATED DIFF (first ${DIFF_MAX} chars):
${updatedPrDiff.substring(0, DIFF_MAX)}

Please check if all blocking issues have been fixed and suggest any remaining improvements.

Return ONLY valid JSON (no markdown, no explanations) with this structure:
{
  "approved": boolean,
  "comments": [{"path": "file.ts", "line": 10, "body": "comment", "severity": "blocking" | "suggestion"}],
  "summary": "review summary"
}`;

    let result = await this.invoke(prompt, 8000);
    let reviewResult: ReviewResult;
    try {
      reviewResult = this.parseReviewOrThrow(result);
    } catch (err) {
      logger.warn('ReviewAgent returned invalid JSON; retrying with stricter output instructions', String(err));
      result = await this.invoke(
        [
          'Your previous response was not valid JSON.',
          'Return ONLY one valid JSON object.',
          'Use only plain ASCII characters in string values — no backticks, no template literals, no raw newlines.',
          prompt,
        ].join('\n\n'),
        8000
      );
      reviewResult = this.parseReviewFromResponse(result);
    }

    logger.info('ReviewAgent re-review completed', { approved: reviewResult.approved });
    return reviewResult;
  }

  private parseReviewOrThrow(response: string): ReviewResult {
    const data = this.robustJsonParse(response);
    return this.normalizeReview(data);
  }

  parseReviewFromResponse(response: string): ReviewResult {
    try {
      return this.parseReviewOrThrow(response);
    } catch (err) {
      logger.error('Failed to parse review output', err);
      return {
        approved: false,
        comments: [
          {
            path: 'pull_request.diff',
            line: 1,
            body: [
              'Review output was not valid JSON. Treating this as a blocking review so the pipeline can continue.',
              response.substring(0, 1000),
            ].join('\n\n'),
            severity: 'blocking',
          },
        ],
        summary: 'Review output was not valid JSON.',
      };
    }
  }

  private normalizeReview(data: any): ReviewResult {
    const comments: ReviewComment[] = (data.comments || []).map((c: any) => ({
      path: c.path,
      line: c.line,
      body: c.body,
      severity: c.severity,
    }));
    return {
      approved: data.approved || false,
      comments,
      summary: data.summary || '',
    };
  }
}
