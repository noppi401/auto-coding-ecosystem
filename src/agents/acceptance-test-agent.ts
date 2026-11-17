import { CodingAgent, CodeOutput } from './coding-agent.js';
import { Task } from '../state/types.js';
import { logger } from '../utils/logger.js';
import { LlmUsageLimitError } from '../utils/llm-errors.js';
import { entryFileFromStartScript } from '../utils/smoke-check.js';

const REQ_DOC_MAX = 12000;

/**
 * 要件定義の受け入れ条件だけから、実装を見ずに HTTP レベルの受け入れテストを書く。
 * 実装を書いたモデルと同じ思い込み（例: GET / のテストが無い）を共有しないよう、実装コードは渡さない。
 * 出力形式と解析は CodingAgent と同じ（新規ファイルは lines、既存の package.json は hunks）。
 */
export class AcceptanceTestAgent extends CodingAgent {
  protected alwaysImplementationRoute = true;

  constructor() {
    super('acceptance.md', 'AcceptanceTestAgent');
  }

  async generateAcceptanceTests(
    task: Task,
    requirementsDoc: string,
    packageJson: string | undefined,
    trackedFiles: string[]
  ): Promise<CodeOutput> {
    await this.loadSystemPrompt();
    logger.section('AcceptanceTestAgent: Writing acceptance tests from requirements');

    const testFile = task.testFiles?.[0] ?? 'test/acceptance.test.js';
    let startScript: string | undefined;
    try { startScript = packageJson ? JSON.parse(packageJson)?.scripts?.start : undefined; } catch { startScript = undefined; }
    const entry = entryFileFromStartScript(startScript);
    const startInstruction = entry
      ? `Start the app with child_process.spawn(process.execPath, [${JSON.stringify(entry)}], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore' }) and stop it with child.kill().`
      : `Start the app the way package.json "scripts.start" does (${startScript ?? 'not defined'}), passing PORT in the environment, and make sure the whole process tree is stopped afterwards.`;
    const existing: Record<string, string> = packageJson ? { 'package.json': packageJson } : {};
    const numbered = (text: string) => text.split('\n').map((line, i) => `${i + 1}| ${line}`).join('\n');

    const prompt = `Write black-box acceptance tests for the application described by these requirements.

REQUIREMENTS:
${requirementsDoc.substring(0, REQ_DOC_MAX)}

FILES IN THE REPOSITORY (names only; you are intentionally not shown their contents):
${trackedFiles.map((f) => `- ${f}`).join('\n') || '- (none)'}

HOW TO START THE APP:
${startInstruction}
Pick a free port first (e.g. listen on port 0 with node:net and read the assigned port), then poll the app over HTTP until it responds (up to ~10 seconds).

${packageJson ? `CURRENT package.json (each line is prefixed with "N| "; the prefix is NOT part of the file):
${numbered(packageJson)}

` : ''}NEW TEST FILE TO CREATE: ${testFile}

Return ONLY one valid JSON object:
{
  "files": [
    {"path": ${JSON.stringify(testFile)}, "lines": ["first line", "second line"]},
    {"path": "package.json", "hunks": [{"startLine": 5, "endLine": 5, "newLines": ["    \\"test\\": \\"...\\","]}]}
  ],
  "commitMessage": "test: ...",
  "prTitle": "...",
  "prBody": "..."
}
- "lines": one JSON string per source line; never put a raw line break inside a JSON string; escape double quotes and backslashes.
- Include the package.json entry only if scripts.test must change to run ${testFile}. Hunks are 1-indexed and inclusive and must not overlap.`;

    let result = await this.invoke(prompt, 16000);
    try {
      return this.parseCodeFromResponse(result, existing);
    } catch (err) {
      if (err instanceof LlmUsageLimitError) throw err;
      logger.warn('AcceptanceTestAgent returned invalid JSON; retrying with stricter output instructions', String(err));
      result = await this.invoke(
        ['Your previous response was not valid JSON.', 'Return ONLY one valid JSON object.', prompt].join('\n\n'),
        16000
      );
      return this.parseCodeFromResponse(result, existing);
    }
  }
}
