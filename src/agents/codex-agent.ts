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
import { loadCodexProjectInstructions } from '../utils/project-instructions.js';
import { appendCodexRuntimeArgs, getCodexRuntimeOptions } from '../utils/codex-options.js';
import {
  LlmUsageLimitError,
  isCodexUsageLimitMessage,
} from '../utils/llm-errors.js';

type CodexOperation = 'generateCode' | 'reviewPr' | 'fixCode';

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

    const response = await this.execCodexPrompt(prompt, 'generateCode');
    return this.parseCode(response);
  }

  async reviewPr(
    task: Task,
    prDiff: string,
    requirementsDoc: string,
    designDoc: string
  ): Promise<ReviewResult> {
    logger.section(`CodexAgent: Reviewing PR for "${task.title}"`);

    const reqMax = Number(process.env.CODEX_REQ_DOC_MAX_CHARS || '4000');
    const designMax = Number(process.env.CODEX_DESIGN_DOC_MAX_CHARS || '3000');

    const prompt = `You are the independent Codex reviewer in an autonomous coding pipeline.

Review the PR diff against the task, requirements, and design. Focus on bugs, missing behavior, security risks, broken tests, and changes that do not match the design.

TASK: ${task.title}
SUMMARY: ${task.summary}

REQUIREMENTS (excerpt):
${requirementsDoc.substring(0, reqMax)}

DESIGN (excerpt):
${designDoc.substring(0, designMax)}

PR DIFF:
${prDiff.substring(0, Number(process.env.CODEX_MAX_DIFF_CHARS || '20000'))}

Return ONLY valid JSON with this structure:
{
  "approved": boolean,
  "comments": [{"path": "file.ts", "line": 10, "body": "comment", "severity": "blocking" | "suggestion"}],
  "summary": "review summary"
}`;

    const response = await this.execCodexPrompt(prompt, 'reviewPr');
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

    const response = await this.execCodexPrompt(prompt, 'fixCode');
    return this.parseFix(response);
  }

  private async execCodexPrompt(prompt: string, operation: CodexOperation): Promise<string> {
    const outputFile = join(
      tmpdir(),
      `codex-output-${Date.now()}-${Math.random().toString(36).substring(7)}.txt`
    );
    const projectInstructions = await loadCodexProjectInstructions();
    const fullPrompt = [
      projectInstructions
        ? `PROJECT RULES:\n${projectInstructions}`
        : '',
      prompt,
    ].filter(Boolean).join('\n\n');

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

    appendCodexRuntimeArgs(args);

    args.push('-');

    try {
      const stdout = await this.execCodex(await resolveCodexBin(), args, fullPrompt, operation);
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

  private resolveCodexTimeoutMs(): number {
    return this.readPositiveMs(process.env.CODEX_TIMEOUT_MS)
      ?? this.readPositiveMs(process.env.AGENT_COMMAND_TIMEOUT_MS)
      ?? 900000;
  }

  private readPositiveMs(value: string | undefined): number | null {
    if (!value) return null;
    const ms = Number(value);
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  }

  private formatTimeoutSeconds(timeoutMs: number): string {
    const seconds = timeoutMs / 1000;
    return `${Number.isInteger(seconds) ? seconds : Number(seconds.toFixed(3))}s`;
  }

  private codexProviderLabel(): string {
    if (process.env.CODEX_USE_OSS === 'true') {
      return `codex:${process.env.CODEX_LOCAL_PROVIDER?.trim() || 'oss'}`;
    }
    return 'codex';
  }

  private buildTimeoutDetails(operation: CodexOperation, timeoutMs: number) {
    const options = getCodexRuntimeOptions();
    return {
      provider: this.codexProviderLabel(),
      model: options.model || 'default',
      operation,
      timeout: this.formatTimeoutSeconds(timeoutMs),
    };
  }

  private buildTimeoutError(operation: CodexOperation, timeoutMs: number): Error {
    const details = this.buildTimeoutDetails(operation, timeoutMs);
    return new Error(
      `Codex command timeout: provider=${details.provider}, model=${details.model}, operation=${details.operation}, timeout=${details.timeout}`
    );
  }

  private async execCodex(command: string, args: string[], stdin: string, operation: CodexOperation): Promise<string> {
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

      const timeoutMs = this.resolveCodexTimeoutMs();
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill();
        logger.warn('Codex command timed out', this.buildTimeoutDetails(operation, timeoutMs));
        reject(this.buildTimeoutError(operation, timeoutMs));
      }, timeoutMs);

      child.on('close', (code) => {
        clearTimeout(timeout);
        if (timedOut) return;
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`Codex failed with code ${code}: ${stderr || stdout}`));
        }
      });

      child.on('error', (err) => {
        clearTimeout(timeout);
        if (timedOut) return;
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
        // ReviewAgent と同じく、想定外・欠落した severity は見逃しを防ぐため blocking 扱いにする
        severity: String(c.severity ?? '').toLowerCase() === 'suggestion' ? 'suggestion' : 'blocking',
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
