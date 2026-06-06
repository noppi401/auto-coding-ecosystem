import { promises as fs } from 'fs';
import { dirname } from 'path';
import type {
  WizardResult,
  ProjectMode,
  PhaseMode,
  LlmProviderChoice,
  CodexIntelligenceChoice,
} from './requestWizard.js';

/**
 * Issue #2: Wizard の選択値（プロバイダー・モデル・フェーズ等）を保存し、次回起動時に復元する。
 * 機微情報（トークン・依頼文・リポジトリ名）は保存しない。
 */

const DEFAULTS_PATH = '.ecosystem/wizard-defaults.json';

export type PersistedWizardDefaults = Partial<
  Pick<
    WizardResult,
    | 'projectMode'
    | 'phaseMode'
    | 'primaryProvider'
    | 'fallbackProvider'
    | 'planningModel'
    | 'implModel'
    | 'codexModel'
    | 'codexIntelligence'
    | 'geminiModel'
  >
>;

const PROVIDERS: LlmProviderChoice[] = ['claude', 'codex', 'gemini'];
const PROJECT_MODES: ProjectMode[] = ['new', 'modify'];
const PHASE_MODES: PhaseMode[] = ['phase1+2', 'phase1only', 'phase2only'];

function asEnum<T extends string>(value: unknown, allowed: T[]): T | undefined {
  return typeof value === 'string' && (allowed as string[]).includes(value)
    ? (value as T)
    : undefined;
}

/** 保存済みの Wizard 既定値を読み込む。存在しない/壊れている場合は空を返す。 */
export async function loadWizardDefaults(): Promise<PersistedWizardDefaults> {
  try {
    const raw = await fs.readFile(DEFAULTS_PATH, 'utf-8');
    const data = JSON.parse(raw) as Record<string, unknown>;
    return {
      projectMode: asEnum(data.projectMode, PROJECT_MODES),
      phaseMode: asEnum(data.phaseMode, PHASE_MODES),
      primaryProvider: asEnum(data.primaryProvider, PROVIDERS),
      fallbackProvider: asEnum(data.fallbackProvider, PROVIDERS),
      planningModel: typeof data.planningModel === 'string' ? data.planningModel : undefined,
      implModel: typeof data.implModel === 'string' ? data.implModel : undefined,
      codexModel: typeof data.codexModel === 'string' ? data.codexModel : undefined,
      codexIntelligence: typeof data.codexIntelligence === 'string'
        ? (data.codexIntelligence as CodexIntelligenceChoice)
        : undefined,
      geminiModel: typeof data.geminiModel === 'string' ? data.geminiModel : undefined,
    };
  } catch {
    return {};
  }
}

/** 今回の Wizard 選択値を保存する（失敗してもフローは止めない）。 */
export async function saveWizardDefaults(result: WizardResult): Promise<void> {
  const toSave: PersistedWizardDefaults = {
    projectMode: result.projectMode,
    phaseMode: result.phaseMode,
    primaryProvider: result.primaryProvider,
    fallbackProvider: result.fallbackProvider,
    planningModel: result.planningModel,
    implModel: result.implModel,
    codexModel: result.codexModel,
    codexIntelligence: result.codexIntelligence,
    geminiModel: result.geminiModel,
  };

  try {
    await fs.mkdir(dirname(DEFAULTS_PATH), { recursive: true });
    await fs.writeFile(DEFAULTS_PATH, JSON.stringify(toSave, null, 2), 'utf-8');
  } catch {
    // 保存失敗は致命的でないため握りつぶす
  }
}
