import { BaseAgent } from './base-agent.js';
import { Task, ReviewResult, ReviewComment } from '../state/types.js';
import { logger } from '../utils/logger.js';

export class ReviewAgent extends BaseAgent {
  constructor() {
    super('review.md', 'ReviewAgent');
  }

  async reviewPr(
    task: Task,
    prDiff: string,
    prFiles: Array<{ filename: string; changes: number; patch: string }>,
    requirementsDoc: string,
    designDoc: string
  ): Promise<ReviewResult> {
    await this.loadSystemPrompt();

    logger.section(`ReviewAgent: Reviewing PR for "${task.title}"`);

    const fileSummary = prFiles
      .map((f) => `- ${f.filename}: ${f.changes} changes`)
      .join('\n');

    const prompt = `Review the following PR for the task:

TASK: ${task.title}
SUMMARY: ${task.summary}

REQUIREMENTS:
${requirementsDoc}

DESIGN:
${designDoc}

FILES CHANGED:
${fileSummary}

PR DIFF (first 5000 chars):
${prDiff.substring(0, 5000)}

Return ONLY valid JSON (no markdown, no explanations) with this structure:
{
  "approved": boolean,
  "comments": [{"path": "file.ts", "line": 10, "body": "comment", "severity": "blocking" | "suggestion"}],
  "summary": "review summary"
}`;

    const result = await this.invoke(prompt, 8000);
    const reviewResult = this.parseReviewFromResponse(result);

    logger.info('ReviewAgent completed', {
      approved: reviewResult.approved,
      commentCount: reviewResult.comments.length,
    });

    return reviewResult;
  }

  async reReviewAfterFix(
    task: Task,
    updatedPrDiff: string,
    prFiles: Array<{ filename: string; changes: number; patch: string }>,
    requirementsDoc: string,
    designDoc: string
  ): Promise<ReviewResult> {
    await this.loadSystemPrompt();

    logger.section(
      `ReviewAgent: Re-reviewing after fixes (iteration ${task.reviewIteration})`
    );

    const fileSummary = prFiles
      .map((f) => `- ${f.filename}: ${f.changes} changes`)
      .join('\n');

    const prompt = `The developer has made fixes based on your previous feedback. Please re-review:

TASK: ${task.title}

FILES CHANGED:
${fileSummary}

UPDATED DIFF (first 5000 chars):
${updatedPrDiff.substring(0, 5000)}

Please check if all blocking issues have been fixed and suggest any remaining improvements.

Return ONLY valid JSON (no markdown, no explanations) with this structure:
{
  "approved": boolean,
  "comments": [{"path": "file.ts", "line": 10, "body": "comment", "severity": "blocking" | "suggestion"}],
  "summary": "review summary"
}`;

    const result = await this.invoke(prompt, 8000);
    const reviewResult = this.parseReviewFromResponse(result);

    logger.info('ReviewAgent re-review completed', {
      approved: reviewResult.approved,
    });

    return reviewResult;
  }

  parseReviewFromResponse(response: string): ReviewResult {
    try {
      const jsonMatch = response.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
      const objectMatch = response.match(/\{[\s\S]*\}/);
      const cleanedResponse = jsonMatch ? jsonMatch[1] : objectMatch ? objectMatch[0] : response;
      const data = JSON.parse(cleanedResponse);

      const comments: ReviewComment[] = (
        data.comments || []
      ).map((c: any) => ({
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
}
