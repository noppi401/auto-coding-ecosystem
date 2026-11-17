import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { logger } from '../utils/logger.js';
import { resolveCodexBin } from '../utils/codex-bin.js';
import { resolveClaudeBin } from '../utils/claude-bin.js';
import { killProcessTree } from '../utils/process-tree.js';
import { parseClaudeStdout } from '../utils/claude-output.js';
import { loadCodexProjectInstructions } from '../utils/project-instructions.js';
import { appendCodexRuntimeArgs, getCodexRuntimeOptions } from '../utils/codex-options.js';
import {
  LlmUsageLimitError,
  isClaudeUsageLimitMessage,
  isCodexUsageLimitMessage,
  isGeminiUsageLimitMessage,
  hasProviderLimitReached,
  markProviderLimitReached,
} from '../utils/llm-errors.js';

/** 起動後、最初の出力が期限内に来なかった（プロセスがハングした）ことを表す。リトライ対象。 */
export class StartupStallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StartupStallError';
  }
}

type LlmProvider = 'auto' | 'claude' | 'codex' | 'local' | 'gemini';
type AgentRoute = 'implementation' | 'planning';

export class BaseAgent {
  protected systemPrompt: string = '';
  protected sessionId: string | null = null;
  protected agentName: string = '';
  protected systemPromptPath: string = '';
  protected lastInvokedProvider: LlmProvider | null = null;
  protected modelOverride: string | null = null;

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

  /**
   * このエージェント呼び出しで使う Claude モデルを上書きする（実装ルートのみ有効）。
   * per-task モデルルーティング用。null を渡すと env ベースの解決に戻る。
   */
  setModelOverride(model: string | null): void {
    this.modelOverride = model;
  }

  protected getLastInvokedProvider(): string | null {
    return this.lastInvokedProvider;
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
    const fallbackProvider = (
      process.env.FALLBACK_LLM_PROVIDER || 'codex'
    ).toLowerCase() as LlmProvider;

    if (!['auto', 'claude', 'codex', 'local', 'gemini'].includes(provider)) {
      throw new Error(`Unsupported LLM provider: ${provider}`);
    }

    // Skip to fallback directly if primary already hit limit this session
    if (hasProviderLimitReached(provider) && fallbackProvider !== provider) {
      logger.info(
        `${this.agentName} ${provider} limit reached, invoking ${fallbackProvider} directly`,
        { route }
      );
      return await this.invokeByProvider(fallbackProvider, userMessage, maxTokens);
    }

    try {
      return await this.invokeByProvider(provider, userMessage, maxTokens);
    } catch (err) {
      if (this.isProviderUsageLimitError(err, provider)) {
        markProviderLimitReached(provider);
        if (process.env.AI_TOKEN_MODE === provider) {
          throw new LlmUsageLimitError(provider as 'claude' | 'codex' | 'gemini', String(err));
        }
        if (fallbackProvider === provider) {
          throw new LlmUsageLimitError(provider as 'claude' | 'codex' | 'gemini', String(err));
        }
        logger.warn(
          `${this.agentName} ${provider} usage limit reached, falling back to ${fallbackProvider}`,
          String(err)
        );
        return await this.invokeByProvider(fallbackProvider, userMessage, maxTokens);
      }
      throw err;
    }
  }

  private async invokeByProvider(
    provider: LlmProvider,
    userMessage: string,
    maxTokens: number
  ): Promise<string> {
    this.lastInvokedProvider = provider;
    const localEnabled = Boolean(this.getLocalLlmUrl() && this.getLocalLlmModel());
    switch (provider) {
      case 'codex': {
        const codexOptions = getCodexRuntimeOptions();
        logger.info(`${this.agentName} invoking Codex...`, {
          model: codexOptions.model || 'default',
          intelligence: codexOptions.intelligence || 'default',
        });
        return await this.invokeCodex(userMessage);
      }
      case 'gemini':
        return await this.invokeGemini(userMessage);
      case 'local':
        if (!localEnabled) {
          throw new Error(
            'LOCAL_LLM_URL and LOCAL_LLM_MODEL are required when provider is local'
          );
        }
        logger.info(`${this.agentName} invoking local LLM...`, {
          model: process.env.LOCAL_LLM_MODEL,
        });
        return await this.invokeLocal(userMessage, maxTokens);
      case 'auto':
      case 'claude':
      default:
        return await this.invokeClaude(userMessage);
    }
  }

  private isProviderUsageLimitError(err: unknown, provider: LlmProvider): boolean {
    if (err instanceof LlmUsageLimitError) return true;
    switch (provider) {
      case 'codex':  return isCodexUsageLimitMessage(err);
      case 'gemini': return isGeminiUsageLimitMessage(err);
      default:       return isClaudeUsageLimitMessage(err);
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
    const projectInstructions = await loadCodexProjectInstructions();

    const prompt = [
      projectInstructions
        ? `PROJECT RULES FROM CLAUDE.md:\n${projectInstructions}`
        : '',
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

    appendCodexRuntimeArgs(args);

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
    let systemPromptFile: string | null = null;

    try {
      logger.info(`${this.agentName} invoking Claude...`);

      const args: string[] = [];

      if (this.sessionId && process.env.RESUME_AGENT_SESSIONS === 'true') {
        args.push('--continue', this.sessionId);
      } else if (this.systemPrompt) {
        systemPromptFile = join(
          tmpdir(),
          `claude-system-${Date.now()}-${Math.random().toString(36).substring(7)}.txt`
        );
        await fs.writeFile(systemPromptFile, this.systemPrompt);
        // --system-prompt-file avoids @path quoting issues on Windows
        args.push('--system-prompt-file', systemPromptFile);
      }

      const route = this.getAgentRoute();
      const envModel =
        route === 'implementation'
          ? (process.env.IMPLEMENTATION_CLAUDE_MODEL || process.env.CLAUDE_MODEL || 'claude-sonnet-4-6')
          : (process.env.PLANNING_CLAUDE_MODEL || process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001');
      // per-task ルーティングは実装ルートのみ上書きを許可する。
      const model =
        route === 'implementation' && this.modelOverride ? this.modelOverride : envModel;

      // Pass prompt via stdin to avoid Windows path/quoting issues with @file syntax.
      // --dangerously-skip-permissions prevents interactive permission prompts that would hang the process.
      // stream-json は起動直後に init イベントを出すので、無反応のハングを早期に検知できる。
      // パイプラインは「テキスト（JSON）を返すこと」だけを期待する。ツールを許すと、モデルが
      // 作業ディレクトリへ直接ファイルを書く・サーバーを常駐させて終了しない・外部サービスを操作する等が起き得るため、
      // ビルトインツールと MCP ツールをすべて無効にする（`--tools=` は空文字引数が落ちる経路でも安全な形）。
      args.push(
        '-p', '--model', model,
        '--output-format', 'stream-json', '--verbose',
        '--tools=', '--strict-mcp-config',
        '--dangerously-skip-permissions'
      );

      const firstOutputTimeoutMs = Number(process.env.CLAUDE_STARTUP_TIMEOUT_MS || '120000');
      const maxStartupRetries = Number(process.env.CLAUDE_STARTUP_RETRIES || '2');
      let stdout = '';
      for (let attempt = 0; ; attempt++) {
        try {
          stdout = await this._execCommand('claude', args, userMessage, {
            firstOutputTimeoutMs,
            finishOnResultEvent: true,
          });
          break;
        } catch (err) {
          if (!(err instanceof StartupStallError) || attempt >= maxStartupRetries) throw err;
          logger.warn(`${this.agentName} claude produced no output at startup; retrying`, {
            attempt: attempt + 1,
            of: maxStartupRetries,
          });
        }
      }

      try {
        const output = parseClaudeStdout(stdout);
        if (output.is_error) {
          throw new Error(`Claude error: ${output.result}`);
        }

        this.sessionId = output.session_id;

        logger.info(`${this.agentName} completed`, {
          sessionId: this.sessionId,
          costUsd: output.total_cost_usd,
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
    } finally {
      if (systemPromptFile) {
        await fs.unlink(systemPromptFile).catch(() => {});
      }
    }
  }

  private async invokeGemini(userMessage: string): Promise<string> {
    try {
      logger.info(`${this.agentName} invoking Gemini via CLI...`);

      const route = this.getAgentRoute();
      const model = route === 'implementation'
        ? (process.env.IMPLEMENTATION_GEMINI_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash')
        : (process.env.PLANNING_GEMINI_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash');

      logger.info(`${this.agentName} using Gemini model: ${model}`);

      const fullPrompt = this.systemPrompt 
        ? `System Instruction: ${this.systemPrompt}\n\nUser Message: ${userMessage}`
        : userMessage;

      /**
       * ヘルプに基づいた引数構成:
       * -m: モデル指定
       * -o json: JSON出力
       * -p: プロンプト（非対話モードを有効化）
       * 
       * Windowsのコマンドライン文字数制限（8,191文字）を回避するため、
       * プロンプト本体は引数ではなく stdin (標準入力) 経由で渡します。
       */
      const args = [
        '-m', model,
        '-o', 'json',
        '-p', 'Instruction'
      ];

      // コマンドを実行し、fullPrompt を標準入力から流し込みます
      const stdout = await this._execCommand('gemini', args, fullPrompt);

      let output: any;
      try {
        let jsonStr = stdout;
        const firstCurly = stdout.indexOf('{');
        const lastCurly = stdout.lastIndexOf('}');
        if (firstCurly !== -1 && lastCurly !== -1 && lastCurly > firstCurly) {
          jsonStr = stdout.substring(firstCurly, lastCurly + 1);
        }
        output = JSON.parse(jsonStr);
      } catch {
        // Markdown コードブロックや二重エスケープを含む応答へのフォールバック
        output = this.robustJsonParse(stdout);
      }
      // JSON出力時のプロパティ名はCLIの実装に依存しますが、一般的な content/result を想定
      const result = output.content || output.result || output.text || 
        (output.candidates && output.candidates[0]?.content?.parts?.[0]?.text) ||
        (typeof output === 'string' ? output : stdout);
      
      logger.info(`${this.agentName} completed via Gemini CLI`);
      return result;

    } catch (err) {
      const errMsg = String(err);
      // Gemini CLI 特有のクォータエラーメッセージを検知
      if (errMsg.includes('TerminalQuotaError') || errMsg.includes('QUOTA_EXHAUSTED') || errMsg.includes('exhausted your capacity')) {
        logger.warn(`${this.agentName} Gemini usage limit detected`);
        throw new LlmUsageLimitError('gemini', errMsg);
      }
      logger.error(`${this.agentName} Gemini CLI invocation failed`, { error: errMsg });
      throw err;
    }
  }

  protected async _execClaudeCommand(command: string, args: string[]): Promise<string> {
    return await this._execCommand(command, args);
  }

  protected async _execCommand(
    command: string,
    args: string[],
    stdin?: string,
    opts: { firstOutputTimeoutMs?: number; finishOnResultEvent?: boolean; exitGraceMs?: number } = {}
  ): Promise<string> {
    const claudeBin = command === 'claude' ? await resolveClaudeBin() : null;
    return new Promise((resolve, reject) => {
      // On Windows, use cmd.exe to execute the command
      const isWindows = process.platform === 'win32';

      // Use shell: true on Windows to allow Node to handle cmd.exe wrapping and argument escaping.
      // This prevents "positional prompt" errors caused by manual string concatenation.
      // ただし claude は cmd.exe 経由だと応答しなくなる事象があるため、実体が見つかれば直接起動する。
      const child = spawn(claudeBin ?? command, args, {
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: isWindows && !claudeBin,
      });

      let stdout = '';
      let stderr = '';

      // チャンクごとの toString() だとマルチバイト文字が境界で分断され文字化けする
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');

      let startupTimer: NodeJS.Timeout | undefined;
      child.stdout?.on('data', (data) => {
        if (startupTimer) {
          clearTimeout(startupTimer);
          startupTimer = undefined;
        }
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
      // 何が来ていたかを残す（原因調査のため）。stdout は長いので末尾だけ。
      const diagnostics = () =>
        `stdoutBytes=${stdout.length} stdoutTail=${JSON.stringify(stdout.slice(-300))} stderr=${JSON.stringify(stderr.slice(-300))}`;
      const timeout = setTimeout(() => {
        clearTimeout(startupTimer);
        killProcessTree(child);
        reject(new Error(`Command timeout after ${Math.round(timeoutMs / 1000)}s; ${diagnostics()}`));
      }, timeoutMs);

      // 起動後すぐ最初の出力が来るはずの呼び出し（stream-json の init）が無反応なら、ハングとして早期に打ち切る
      if (opts.firstOutputTimeoutMs) {
        const ms = opts.firstOutputTimeoutMs;
        startupTimer = setTimeout(() => {
          clearTimeout(timeout);
          killProcessTree(child);
          reject(new StartupStallError(`No output within ${Math.round(ms / 1000)}s of start; ${diagnostics()}`));
        }, ms);
      }

      let settled = false;
      let graceTimer: NodeJS.Timeout | undefined;
      const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearTimeout(startupTimer);
        clearTimeout(graceTimer);
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`Command failed with code ${code}: ${stderr || stdout}`));
        }
      };
      // 孫プロセスが pipe を握り続けると 'close' が来ない。完了後・終了後は猶予を置いて pipe を破棄し、待ち続けない
      const abandonPipes = () => {
        child.stdout?.destroy();
        child.stderr?.destroy();
      };
      const graceMs = opts.exitGraceMs ?? 5000;

      if (opts.finishOnResultEvent) {
        let lineBuf = '';
        child.stdout?.on('data', (data) => {
          lineBuf += data.toString();
          const lines = lineBuf.split('\n');
          lineBuf = lines.pop() ?? '';
          if (!graceTimer && lines.some((l) => l.startsWith('{"type":"result"'))) {
            // result を受け取った = 生成は完了済み。終了しないプロセス（常駐させた子プロセス等）は打ち切る
            graceTimer = setTimeout(() => {
              killProcessTree(child);
              abandonPipes();
              finish(0);
            }, graceMs);
          }
        });
      }

      child.on('exit', (code) => {
        if (settled) return;
        graceTimer ??= setTimeout(() => {
          abandonPipes();
          finish(code);
        }, graceMs);
      });

      child.on('close', (code) => finish(code));

      child.on('error', (err) => {
        settled = true;
        clearTimeout(timeout);
        clearTimeout(startupTimer);
        clearTimeout(graceTimer);
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

  /**
   * Markdownや二重エスケープされた文字を含む文字列からJSONを堅牢に抽出・パースします。
   */
  protected robustJsonParse(input: string): any {
    let cleaned = input.trim();

    // 0. そのままパースできるならそれを採用（JSON 文字列内の ``` を誤抽出しない）
    try {
      return JSON.parse(cleaned);
    } catch { /* fall through to extraction */ }

    // 1. Markdownコードブロックからの抽出を試行
    // フェンスが最初の { より前にある場合のみ対象（JSON 文字列内の ``` は無視）
    const markdownMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    const firstCurlyIdx = cleaned.indexOf('{');
    if (
      markdownMatch && markdownMatch[1] &&
      (firstCurlyIdx === -1 || (markdownMatch.index ?? 0) < firstCurlyIdx)
    ) {
      cleaned = markdownMatch[1].trim();
    } else {
      // 2. 最初の { と 最後の } の間を抽出
      const firstCurly = cleaned.indexOf('{');
      const lastCurly = cleaned.lastIndexOf('}');
      if (firstCurly !== -1 && lastCurly !== -1 && lastCurly > firstCurly) {
        cleaned = cleaned.substring(firstCurly, lastCurly + 1);
      }
    }

    try {
      return JSON.parse(cleaned);
    } catch (firstErr) {
      // 2b. フォールバック: 囲みの内側に ``` がある場合、元の入力から { ～ } を切り出す
      const origFirst = input.indexOf('{');
      const origLast = input.lastIndexOf('}');
      if (origFirst !== -1 && origLast > origFirst) {
        try {
          return JSON.parse(input.substring(origFirst, origLast + 1));
        } catch { /* ignore */ }
      }

      // 3. フォールバック: 二重エスケープ（\" など）のハンドリング
      if (cleaned.includes('\\"')) {
        try {
          const unescaped = cleaned
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, '\\')
            .replace(/\\n/g, '\n');
          return JSON.parse(unescaped);
        } catch { /* ignore */ }
      }

      // 4. フォールバック: バッククォートで囲まれた値をダブルクォートに変換
      // モデルが "key": `value` のようにテンプレートリテラル構文を使った場合
      try {
        const backtickFixed = cleaned.replace(/:\s*`((?:[^`\\]|\\.)*)`/g, (_m, content: string) => {
          const escaped = content
            .replace(/\\/g, '\\\\')
            .replace(/"/g, '\\"')
            .replace(/\n/g, '\\n')
            .replace(/\r/g, '\\r');
          return `: "${escaped}"`;
        });
        if (backtickFixed !== cleaned) return JSON.parse(backtickFixed);
      } catch { /* ignore */ }

      // 5. フォールバック: JSON文字列内のリテラル改行をエスケープ
      // モデルが文字列フィールド内で実際の改行を使った場合（Unterminated string エラー）
      try {
        const newlineFixed = cleaned.replace(/"((?:[^"\\]|\\.)*)"/g, (_m, inner: string) => {
          const escaped = inner
            .replace(/\n/g, '\\n')
            .replace(/\r/g, '\\r')
            .replace(/\t/g, '\\t');
          return `"${escaped}"`;
        });
        if (newlineFixed !== cleaned) return JSON.parse(newlineFixed);
      } catch { /* ignore */ }

      throw firstErr;
    }
  }
}
