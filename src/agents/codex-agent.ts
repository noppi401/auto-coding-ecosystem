import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { join } from 'path';
import { BaseAgent } from './base-agent.js';
import { tmpdir } from 'os';
import { Task, ReviewComment, ReviewResult } from '../state/types.js';
import { CodeOutput } from './coding-agent.js';
import { FixOutput } from './fix-agent.js';
import { logger } from '../utils/logger.js';
import { resolveCodexBin } from '../utils/codex-bin.js';
import {
  LlmUsageLimitError,
  isCodexUsageLimitMessage,
} from '../utils/llm-errors.js';

export class CodexAgent extends BaseAgent {
  constructor() {
    super('', 'CodexAgent'); // CodexAgent does not use a system prompt file directly
  }

  async generateCode(
    task: Task,
    requirementsDoc: string,
    designDoc: string
  ): Promise<CodeOutput> {
    logger.section(`CodexAgent: Generating code for "${task.title}"`);

    const prompt = `You are the Codex implementation worker in an autonomous coding pipeline.

Generate production-ready code for this task. Return complete file contents for every file that should be created or updated.

TASK: ${task.title}
SUMMARY: ${task.summary}
TARGET FILES:
${task.targetFiles.map((file) => `- ${file}`).join('\n')}

REQUIREMENTS:
${requirementsDoc}

DESIGN:
${designDoc}

Return ONLY valid JSON with this structure:
{
  "files": [{"path": "src/file.ts", "content": "..."}],
  "commitMessage": "...",
  "prTitle": "...",
  "prBody": "..."
}`;

    const response = await this.execCodexPrompt(prompt);
    return this.parseCode(response);
  }

  async reviewPr(
    task: Task,
    prDiff: string,
    requirementsDoc: string,
    designDoc: string
  ): Promise<ReviewResult> {
    logger.section(`CodexAgent: Reviewing PR for "${task.title}"`);

    const prompt = `You are the independent Codex reviewer in an autonomous coding pipeline.

Review the PR diff against the task, requirements, and design. Focus on bugs, missing behavior, security risks, broken tests, and changes that do not match the design.

TASK: ${task.title}
SUMMARY: ${task.summary}

REQUIREMENTS:
${requirementsDoc}

DESIGN:
${designDoc}

PR DIFF:
${prDiff.substring(0, Number(process.env.CODEX_MAX_DIFF_CHARS || '20000'))}

Return ONLY valid JSON with this structure:
{
  "approved": boolean,
  "comments": [{"path": "file.ts", "line": 10, "body": "comment", "severity": "blocking" | "suggestion"}],
  "summary": "review summary"
}`;

    const response = await this.execCodexPrompt(prompt);
    return this.parseReview(response);
  }

  async fixCode(
    task: Task,
    reviewComments: ReviewComment[],
    prDiff: string,
    requirementsDoc: string,
    designDoc: string
  ): Promise<FixOutput> {
    logger.section(`CodexAgent: Fixing code for "${task.title}"`);

    const comments = reviewComments
      .map((c) => `- ${c.severity}: ${c.path}:${c.line} ${c.body}`)
      .join('\n');

    const prompt = `You are the Codex implementation worker in an autonomous coding pipeline.

Fix the PR based on the review comments. Return complete file contents for every file that must be changed.

TASK: ${task.title}
SUMMARY: ${task.summary}

REQUIREMENTS:
${requirementsDoc}

DESIGN:
${designDoc}

CURRENT PR DIFF:
${prDiff.substring(0, Number(process.env.CODEX_MAX_DIFF_CHARS || '20000'))}

REVIEW COMMENTS:
${comments}

Return ONLY valid JSON with this structure:
{
  "files": [{"path": "src/file.ts", "content": "..."}],
  "commitMessage": "fix: ...",
  "fixSummary": "..."
}`;

    const response = await this.execCodexPrompt(prompt);
    return this.parseFix(response);
  }

  private async execCodexPrompt(prompt: string): Promise<string> {
    const outputFile = join(
      tmpdir(),
      `codex-output-${Date.now()}-${Math.random().toString(36).substring(7)}.txt`
    );

    const args = [
      'exec',
      '--skip-git-repo-check',
      '--sandbox',
      process.env.CODEX_SANDBOX || 'read-only',
      '--output-last-message',
      outputFile,
    ];

    if (process.env.CODEX_USE_OSS === 'true') {
      args.push('--oss');
      if (process.env.CODEX_LOCAL_PROVIDER) {
        args.push('--local-provider', process.env.CODEX_LOCAL_PROVIDER);
      }
    }

    if (process.env.CODEX_MODEL) {
      args.push('--model', process.env.CODEX_MODEL);
    }

    args.push('-');

    try {
      const stdout = await this.execCodex(await resolveCodexBin(), args, prompt);
      const finalMessage = await fs.readFile(outputFile, 'utf-8').catch(() => stdout);
      const trimmed = finalMessage.trim();
      if (isCodexUsageLimitMessage(trimmed)) {
        throw new LlmUsageLimitError('codex', trimmed);
      }
      return trimmed;
    } catch (err) {
      if (isCodexUsageLimitMessage(err)) {
        throw new LlmUsageLimitError('codex', String(err));
      }
      throw err;
    } finally {
      await fs.unlink(outputFile).catch(() => {});
    }
  }

  private async execCodex(command: string, args: string[], stdin: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: process.cwd(),
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      child.stdin?.write(stdin);
      child.stdin?.end();

      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error('Codex command timeout after 300s'));
      }, Number(process.env.CODEX_TIMEOUT_MS || '300000'));

      child.on('close', (code) => {
        clearTimeout(timeout);
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`Codex failed with code ${code}: ${stderr || stdout}`));
        }
      });

      child.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
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
      commitMessage: data.commitMessage || `fix: address review feedback for ${Date.now()}`,
      fixSummary: data.fixSummary || 'Codex generated fixes.',
    };
  }

  private parseCode(response: string): CodeOutput {
    const data = this.parseJson(response) as CodeOutput;
    return {
      files: data.files || [],
      commitMessage: data.commitMessage || `feat: implement ${Date.now()}`,
      prTitle: data.prTitle || 'Implement task',
      prBody: data.prBody || 'Codex generated implementation.',
    };
  }

  private parseJson(response: string): any {
    // BaseAgentの堅牢なパース処理を使用
    return this.robustJsonParse(response);
  }
}
