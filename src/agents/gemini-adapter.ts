import { BaseAgent } from './base-agent.js';
import { Task, ReviewComment, ReviewResult } from '../state/types.js';
import { CodeOutput } from './coding-agent.js';
import { FixOutput } from './fix-agent.js';
import { logger } from '../utils/logger.js';

/**
 * GeminiAgent
 * CodexAgentと同様の構造を持ち、Gemini APIを使用してコード生成、レビュー、修正を自動で行います。
 */
export class GeminiAgent extends BaseAgent {
  constructor() {
    super('', 'GeminiAgent');
  }

  async generateCode(
    task: Task,
    requirementsDoc: string,
    designDoc: string
  ): Promise<CodeOutput> {
    logger.section(`GeminiAgent: Generating code for "${task.title}"`);

    const prompt = `Generate production-ready code for this task. Return ONLY valid JSON.

TASK: ${task.title}
SUMMARY: ${task.summary}
TARGET FILES: ${task.targetFiles.join(', ')}

REQUIREMENTS:
${requirementsDoc}

DESIGN:
${designDoc}

Return structure:
{
  "files": [{"path": "src/file.ts", "content": "..."}],
  "commitMessage": "...",
  "prTitle": "...",
  "prBody": "..."
}`;

    const response = await this.invoke(prompt);
    return this.parseCode(response);
  }

  async reviewPr(
    task: Task,
    prDiff: string,
    requirementsDoc: string,
    designDoc: string
  ): Promise<ReviewResult> {
    logger.section(`GeminiAgent: Reviewing PR for "${task.title}"`);

    const prompt = `Review the PR diff against the requirements and design. Return ONLY valid JSON.

TASK: ${task.title}
PR DIFF:
${prDiff.substring(0, 20000)}

REQUIREMENTS:
${requirementsDoc}

DESIGN:
${designDoc}

Return structure:
{
  "approved": boolean,
  "comments": [{"path": "file.ts", "line": 10, "body": "comment", "severity": "blocking" | "suggestion"}],
  "summary": "review summary"
}`;

    const response = await this.invoke(prompt);
    return this.parseReview(response);
  }

  async fixCode(
    task: Task,
    reviewComments: ReviewComment[],
    prDiff: string,
    requirementsDoc: string,
    designDoc: string
  ): Promise<FixOutput> {
    logger.section(`GeminiAgent: Fixing code for "${task.title}"`);

    const comments = reviewComments
      .map((c) => `- ${c.severity}: ${c.path}:${c.line} ${c.body}`)
      .join('\n');

    const prompt = `Fix the PR based on review comments. Return ONLY valid JSON.

CURRENT DIFF:
${prDiff.substring(0, 20000)}

REVIEW COMMENTS:
${comments}

Return structure:
{
  "files": [{"path": "src/file.ts", "content": "..."}],
  "commitMessage": "fix: ...",
  "fixSummary": "..."
}`;

    const response = await this.invoke(prompt);
    return this.parseFix(response);
  }

  private parseReview(response: string): ReviewResult {
    const data = this.parseJson(response);
    return {
      approved: Boolean(data.approved),
      comments: (data.comments || []).map((c: any) => ({
        path: c.path || 'pull_request.diff',
        line: Number(c.line || 1),
        body: c.body || '',
        severity: c.severity === 'blocking' ? 'blocking' : 'suggestion',
      })),
      summary: data.summary || '',
    };
  }

  private parseFix(response: string): FixOutput {
    const data = this.parseJson(response) as FixOutput;
    return {
      files: data.files || [],
      commitMessage: data.commitMessage || 'fix: address review feedback',
      fixSummary: data.fixSummary || '',
    };
  }

  private parseCode(response: string): CodeOutput {
    const data = this.parseJson(response) as CodeOutput;
    return {
      files: data.files || [],
      commitMessage: data.commitMessage || 'feat: implement task',
      prTitle: data.prTitle || 'Implement task',
      prBody: data.prBody || '',
    };
  }

  private parseJson(response: string): any {
    try {
      return this.robustJsonParse(response);
    } catch (err) {
      throw new Error(`Failed to parse JSON from Gemini response: ${err}\nResponse: ${response}`);
    }
  }
}