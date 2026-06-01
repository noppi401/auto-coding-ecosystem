import { BaseAgent } from './base-agent.js';
import { Task } from '../state/types.js';
import { logger } from '../utils/logger.js';
import { LlmUsageLimitError, isCodexUsageLimitMessage } from '../utils/llm-errors.js';

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

    const currentFileMax = Number(process.env.CODING_CURRENT_FILE_MAX_CHARS || '6000');
    const truncatedCurrentFiles: Record<string, string> = {};
    for (const [path, content] of Object.entries(currentFiles)) {
      truncatedCurrentFiles[path] = content.substring(0, currentFileMax);
    }

    const targetFiles = task.targetFiles;
    const chunkSize = Number(process.env.CODING_FILE_CHUNK_SIZE || '4');

    if (targetFiles.length <= chunkSize) {
      const output = await this._generateChunk(
        task, requirementsDoc, designDoc, truncatedCurrentFiles, targetFiles, null
      );
      logger.info('CodingAgent completed', { fileCount: output.files.length });
      return output;
    }

    // Split into chunks to avoid token exhaustion on large tasks
    const chunks: string[][] = [];
    for (let i = 0; i < targetFiles.length; i += chunkSize) {
      chunks.push(targetFiles.slice(i, i + chunkSize));
    }
    logger.info(
      `CodingAgent: ${targetFiles.length} target files → ${chunks.length} chunks of ≤${chunkSize}`,
      chunks.map((c, i) => `chunk${i + 1}: ${c.join(', ')}`).join(' | ')
    );

    const allFiles: CodeOutput['files'] = [];
    let firstOutput: CodeOutput | null = null;

    for (const [index, chunk] of chunks.entries()) {
      logger.info(`CodingAgent: chunk ${index + 1}/${chunks.length}`, chunk.join(', '));
      const chunkCurrentFiles: Record<string, string> = {};
      for (const path of chunk) {
        if (truncatedCurrentFiles[path]) {
          chunkCurrentFiles[path] = truncatedCurrentFiles[path];
        }
      }
      const chunkOutput = await this._generateChunk(
        task, requirementsDoc, designDoc, chunkCurrentFiles, chunk,
        { current: index + 1, total: chunks.length }
      );
      allFiles.push(...chunkOutput.files);
      if (!firstOutput) firstOutput = chunkOutput;
    }

    logger.info('CodingAgent completed (chunked)', { fileCount: allFiles.length });
    return {
      files: allFiles,
      commitMessage: firstOutput!.commitMessage,
      prTitle: firstOutput!.prTitle,
      prBody: firstOutput!.prBody,
    };
  }

  private async _generateChunk(
    task: Task,
    requirementsDoc: string,
    designDoc: string,
    currentFiles: Record<string, string>,
    targetFiles: string[],
    chunkInfo: { current: number; total: number } | null
  ): Promise<CodeOutput> {
    const chunkNote = chunkInfo
      ? `NOTE: This is chunk ${chunkInfo.current} of ${chunkInfo.total} for this task. Generate ONLY the files listed in TARGET FILES below.\n\n`
      : '';

    const prompt = `${chunkNote}Generate code for the following task:

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
${targetFiles.map((file) => `- ${file}`).join('\n') || '- not specified'}

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
      if (err instanceof LlmUsageLimitError) {
        throw err;
      }
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

    return codeOutput;
  }

  parseCodeFromResponse(response: string): CodeOutput {
    try {
      this.throwIfUsageLimitTextResponse(response);
      const data = this.robustJsonParse(response);
      return this.normalizeCodeOutput(data);
    } catch (err) {
      logger.error('Failed to parse code output', err);
      throw err;
    }
  }

  private normalizeCodeOutput(data: any): CodeOutput {
    this.throwIfUsageLimitOutput(data?.error || data?.message || data?.result || data?.reason);

    if (!Array.isArray(data?.files)) {
      throw new Error('CodingAgent output is missing required files array.');
    }

    if (data.files.length === 0) {
      throw new Error(
        'CodingAgent returned zero files. No commit was attempted; the implementation provider did not produce file changes.'
      );
    }

    const files = data.files.map((file: any, index: number) => {
      if (!file || typeof file.path !== 'string' || file.path.trim() === '') {
        throw new Error(`CodingAgent file entry ${index + 1} is missing a valid path.`);
      }

      const content = typeof file.contentBase64 === 'string'
        ? Buffer.from(file.contentBase64, 'base64').toString('utf-8')
        : file.content;

      if (typeof content !== 'string') {
        throw new Error(`CodingAgent file entry "${file.path}" is missing contentBase64 or content.`);
      }

      return {
        path: file.path,
        content,
        contentBase64: file.contentBase64,
      };
    });

    return {
      files,
      commitMessage: data.commitMessage || data.commit_message || 'feat: implement task',
      prTitle: data.prTitle || data.pr_title || 'Implement task',
      prBody: data.prBody || data.pr_body || '',
    };
  }

  private throwIfUsageLimitTextResponse(response: string): void {
    const trimmed = response.trim();
    if (
      trimmed.startsWith('{') ||
      trimmed.startsWith('[') ||
      trimmed.startsWith('```')
    ) {
      return;
    }

    this.throwIfUsageLimitOutput(trimmed);
  }

  private throwIfUsageLimitOutput(value: unknown): void {
    if (value === undefined || value === null || value === '') {
      return;
    }
    if (!isCodexUsageLimitMessage(value)) {
      return;
    }

    const provider = this.getLastInvokedProvider();
    const usageProvider =
      provider === 'claude' || provider === 'codex' || provider === 'gemini'
        ? provider
        : 'codex';
    const snippet = String(value).replace(/\s+/g, ' ').slice(0, 500);

    throw new LlmUsageLimitError(
      usageProvider,
      `Implementation provider returned usage-limit text instead of code output: ${snippet}`
    );
  }
}
