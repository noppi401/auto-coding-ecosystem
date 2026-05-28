const CODEX_INTELLIGENCE_LEVELS = ['low', 'medium', 'high', 'xhigh'] as const;

export type CodexIntelligence = typeof CODEX_INTELLIGENCE_LEVELS[number];

export interface CodexRuntimeOptions {
  model?: string;
  intelligence?: CodexIntelligence;
}

export function isCodexIntelligence(value: string): value is CodexIntelligence {
  return (CODEX_INTELLIGENCE_LEVELS as readonly string[]).includes(value);
}

export function parseCodexIntelligence(value: string): CodexIntelligence {
  const normalized = value.trim();
  if (isCodexIntelligence(normalized)) {
    return normalized;
  }

  throw new Error(
    `Unsupported Codex intelligence: ${value}. Must be one of: ${CODEX_INTELLIGENCE_LEVELS.join(', ')}`
  );
}

export function getCodexRuntimeOptions(): CodexRuntimeOptions {
  const model = process.env.CODEX_MODEL?.trim() || undefined;
  const intelligenceRaw =
    process.env.CODEX_INTELLIGENCE?.trim() ||
    process.env.CODEX_MODEL_REASONING_EFFORT?.trim();

  return {
    model,
    intelligence: intelligenceRaw
      ? parseCodexIntelligence(intelligenceRaw)
      : undefined,
  };
}

export function appendCodexRuntimeArgs(args: string[]): void {
  const options = getCodexRuntimeOptions();

  if (options.model) {
    args.push('--model', options.model);
  }

  if (options.intelligence) {
    args.push('--config', `model_reasoning_effort="${options.intelligence}"`);
  }
}
