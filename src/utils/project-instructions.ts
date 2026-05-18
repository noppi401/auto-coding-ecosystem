import { promises as fs } from 'fs';
import { join } from 'path';
import { logger } from './logger.js';

let cachedProjectInstructions: string | null | undefined;

export async function loadCodexProjectInstructions(): Promise<string> {
  if (cachedProjectInstructions !== undefined) {
    return cachedProjectInstructions ?? '';
  }

  const instructionFile = process.env.CODEX_PROJECT_RULES_FILE || 'CLAUDE.md';
  const instructionPath = join(process.cwd(), instructionFile);

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
