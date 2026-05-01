import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { logger } from '../utils/logger.js';
import { resolveCodexBin } from '../utils/codex-bin.js';
import {
  LlmUsageLimitError,
  hasClaudeUsageLimitReached,
  isClaudeUsageLimitMessage,
  isCodexUsageLimitMessage,
  markClaudeUsageLimitReached,
} from '../utils/llm-errors.js';

interface ClaudeOutput {
  type: string;
  is_error: boolean;
  result: string;
  session_id: string;
}

type LlmProvider = 'auto' | 'claude' | 'codex' | 'local';
type AgentRoute = 'implementation' | 'planning';

export class BaseAgent {
  protected systemPrompt: string = '';
  protected sessionId: string | null = null;
  protected agentName: string = '';
  protected systemPromptPath: string = '';

  constructor(
    systemPromptPath: string = '',
    agentName: string = 'BaseAgent'
  ) {
    this.systemPromptPath = systemPromptPath;
    this.agentName = agentName;
  }

  async loadSystemPrompt(): Promise<void> {
    if (!this.systemPromptPath) return;

    try {
      const promptPath = join(
        process.cwd(),
        'prompts',
        this.systemPromptPath
      );
      this.systemPrompt = await fs.readFile(promptPath, 'utf-8');
    } catch (err) {
      logger.error(
        `Failed to load system prompt for ${this.agentName}`,
        err
      );
      throw err;
    }
  }

  getSystemPrompt(): string {
    return this.systemPrompt;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  setSessionId(id: string | null): void {
    this.sessionId = id;
  }

  // Backward compatibility
  setHistory(_: any): void {
    // no-op: sessions are managed by claude CLI
  }

  getHistory(): string | null {
    return this.sessionId;
  }

  async invoke(userMessage: string, maxTokens: number = 8000): Promise<string> {
    const route = this.getAgentRoute();
    const provider = (
      route === 'implementation'
        ? (process.env.IMPLEMENTATION_LLM_PROVIDER || 'claude')
        : (process.env.PLANNING_LLM_PROVIDER || 'claude')
    ).toLowerCase() as LlmProvider;
    const localEnabled = Boolean(this.getLocalLlmUrl() && this.getLocalLlmModel());

    if (!['auto', 'claude', 'codex', 'local'].includes(provider)) {
      throw new Error(`Unsupported LLM provider: ${provider}`);
    }

    if (provider === 'codex' || (provider === 'claude' && hasClaudeUsageLimitReached())) {
      logger.info(`${this.agentName} invoking Codex...`, {
        route,
        model: process.env.CODEX_MODEL || 'default',
        reason: provider === 'claude' ? 'Claude usage limit already reached' : 'configured provider',
      });
      return await this.invokeCodex(userMessage);
    }

    if (provider === 'local') {
      if (!localEnabled) {
        throw new Error(
          'LOCAL_LLM_URL and LOCAL_LLM_MODEL are required when provider is local'
        );
      }

      try {
        logger.info(`${this.agentName} invoking local LLM...`, {
          model: process.env.LOCAL_LLM_MODEL,
        });
        return await this.invokeLocal(userMessage, maxTokens);
      } catch (err) {
        if (provider === 'local') {
          logger.error(`${this.agentName} local LLM failed`, err);
          throw err;
        }
        throw err;
      }
    }

    try {
      return await this.invokeClaude(userMessage);
    } catch (err) {
      if (this.isClaudeUsageLimitError(err)) {
        markClaudeUsageLimitReached();
        if (process.env.AI_TOKEN_MODE === 'claude') {
          throw new LlmUsageLimitError('claude', String(err));
        }
        logger.warn(
          `${this.agentName} Claude usage limit reached, falling back to Codex`,
          String(err)
        );
        return await this.invokeCodex(userMessage);
      }
      throw err;
    }
  }

  private async invokeLocal(userMessage: string, maxTokens: number): Promise<string> {
    const baseUrl = this.getLocalLlmUrl();
    const model = this.getLocalLlmModel();

    if (!baseUrl || !model) {
      throw new Error('LOCAL_LLM_URL and LOCAL_LLM_MODEL are required for local LLM usage');
    }

    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.LOCAL_LLM_API_KEY
          ? { Authorization: `Bearer ${process.env.LOCAL_LLM_API_KEY}` }
          : {}),
      },
      body: JSON.stringify({
        model,
        messages: [
          ...(this.systemPrompt
            ? [{ role: 'system', content: this.systemPrompt }]
            : []),
          { role: 'user', content: userMessage },
        ],
        temperature: Number(process.env.LOCAL_LLM_TEMPERATURE || '0.2'),
        max_tokens: maxTokens,
      }),
    });

    if (!response.ok) {
      throw new Error(`Local LLM HTTP ${response.status}: ${await response.text()}`);
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string }; text?: string }>;
    };
    const content = data.choices?.[0]?.message?.content || data.choices?.[0]?.text;
    if (!content) {
      throw new Error('Local LLM returned no content');
    }

    logger.info(`${this.agentName} completed with local LLM`);
    return content;
  }

  private async invokeCodex(userMessage: string): Promise<string> {
    const outputFile = join(
      tmpdir(),
      `codex-fallback-${Date.now()}-${Math.random().toString(36).substring(7)}.txt`
    );

    const prompt = [
      this.systemPrompt ? `SYSTEM PROMPT:\n${this.systemPrompt}` : '',
      `USER MESSAGE:\n${userMessage}`,
    ].filter(Boolean).join('\n\n');

    const args = [
      'exec',
      '--skip-git-repo-check',
      '--sandbox',
      process.env.CODEX_SANDBOX || 'read-only',
      '--output-last-message',
      outputFile,
    ];

    if (process.env.CODEX_MODEL) {
      args.push('--model', process.env.CODEX_MODEL);
    }

    args.push('-');

    try {
      const stdout = await this._execCommand(await resolveCodexBin(), args, prompt);
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

  private async invokeClaude(userMessage: string): Promise<string> {
    try {
      logger.info(`${this.agentName} invoking Claude...`);

      const args: string[] = [];

      if (this.sessionId && process.env.RESUME_AGENT_SESSIONS === 'true') {
        args.push('--continue', this.sessionId);
      } else if (this.systemPrompt) {
        // Write system prompt to temp file to avoid quoting issues
        const systemPromptFile = join(tmpdir(), `claude-system-${Date.now()}-${Math.random().toString(36).substring(7)}.txt`);
        await fs.writeFile(systemPromptFile, this.systemPrompt);
        args.push('--system-prompt', `@${systemPromptFile}`);
      }

      // Write user message to temp file to avoid shell quoting issues
      const tempFile = join(tmpdir(), `claude-prompt-${Date.now()}-${Math.random().toString(36).substring(7)}.txt`);
      await fs.writeFile(tempFile, userMessage);
      args.push('-p', '--model', process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001', '--output-format', 'json', `@${tempFile}`);

      const stdout = await this._execClaudeCommand('npm', ['exec', 'claude', '--', ...args]);

      await fs.unlink(tempFile).catch(() => {});
      // Clean up system prompt file if it exists
      if (this.systemPrompt && args[0] === '--system-prompt') {
        const systemPromptPath = args[1].replace(/^@/, '');
        await fs.unlink(systemPromptPath).catch(() => {});
      }

      try {
        const output = JSON.parse(stdout) as ClaudeOutput;
        if (output.is_error) {
          throw new Error(`Claude error: ${output.result}`);
        }

        this.sessionId = output.session_id;

        logger.info(`${this.agentName} completed`, {
          sessionId: this.sessionId,
        });

        return output.result;
      } catch (parseErr) {
        logger.error('Failed to parse Claude output', {
          stdout: stdout.substring(0, 500),
          error: parseErr,
        });
        throw parseErr;
      }
    } catch (err) {
      logger.error(`${this.agentName} failed`, err);
      throw err;
    }
  }

  protected async _execClaudeCommand(command: string, args: string[]): Promise<string> {
    return await this._execCommand(command, args);
  }

  protected async _execCommand(command: string, args: string[], stdin?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      // On Windows, use cmd.exe to execute the command
      const isWindows = process.platform === 'win32';

      let child;
      if (isWindows) {
        // Build command line carefully for cmd.exe
        // Args that contain spaces need quoting
        const cmdParts = [command, ...args.map(a => {
          // If arg contains spaces, quote it
          if (a.includes(' ')) {
            return `"${a.replace(/"/g, '\\"')}"`;
          }
          return a;
        })];
        const cmdLine = cmdParts.join(' ');
        child = spawn('cmd.exe', ['/s', '/c', cmdLine], {
          env: process.env,
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: false,
        });
      } else {
        child = spawn(command, args, {
          env: process.env,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      }

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      if (stdin) {
        child.stdin?.write(stdin);
      }
      child.stdin?.end();

      const timeoutMs = Number(process.env.AGENT_COMMAND_TIMEOUT_MS || '900000');
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error(`Command timeout after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);

      child.on('close', (code) => {
        clearTimeout(timeout);
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`Command failed with code ${code}: ${stderr || stdout}`));
        }
      });

      child.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  private getAgentRoute(): AgentRoute {
    const implementationAgents = (
      process.env.IMPLEMENTATION_AGENTS ||
      process.env.LOCAL_IMPLEMENTATION_AGENTS ||
      'CodingAgent,FixAgent'
    ).split(',').map((name) => name.trim()).filter(Boolean);

    return implementationAgents.includes(this.agentName)
      ? 'implementation'
      : 'planning';
  }

  private getLocalLlmUrl(): string | undefined {
    return process.env.LOCAL_LLM_URL;
  }

  private getLocalLlmModel(): string | undefined {
    return process.env.LOCAL_LLM_MODEL;
  }

  private isClaudeUsageLimitError(err: unknown): boolean {
    return isClaudeUsageLimitMessage(err);
  }
}
