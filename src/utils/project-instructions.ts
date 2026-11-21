import { promises as fs } from 'fs';
import { join, resolve } from 'path';
import { logger } from './logger.js';

let cachedProjectInstructions: string | null | undefined;

export async function loadCodexProjectInstructions(): Promise<string> {
  if (cachedProjectInstructions !== undefined) {
    return cachedProjectInstructions ?? '';
  }

  // 既定は生成するプロジェクト向けの Codex 用ルール。ACE 自身の CLAUDE.md は ACE の開発用ルール
  // （日本語で書く、.ecosystem の運用など）を含み、生成するプロジェクトには当てはまらないため使わない。
  const instructionFile =
    process.env.CODEX_PROJECT_RULES_FILE || join('prompts', 'codex-project-rules.md');
  // 相対パスは実行ディレクトリから解決する。絶対パスはそのまま使う
  const instructionPath = resolve(process.cwd(), instructionFile);

  try {
    const content = await fs.readFile(instructionPath, 'utf-8');
    cachedProjectInstructions = content.trim();
    return cachedProjectInstructions;
  } catch (err: any) {
    if (err?.code !== 'ENOENT') {
      logger.warn('Failed to load Codex project instructions', {
        path: instructionFile,
        error: String(err),
      });
    }
    cachedProjectInstructions = null;
    return '';
  }
}
