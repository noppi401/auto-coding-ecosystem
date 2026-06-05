import type { TaskComplexity } from '../state/types.js';

/**
 * タスク複雑度に応じた実装モデルの決定論的ルーティング。
 *
 * モデルに非言語処理（モデル選択判断）をさせない方針（CLAUDE.md 規約5）に従い、
 * Planning が付与した complexity ランクから、決定論的にモデルを決める。
 */

const DEFAULT_LOW = 'claude-haiku-4-5-20251001';
const DEFAULT_MEDIUM = 'claude-sonnet-4-6';
const DEFAULT_HIGH = 'claude-opus-4-7';

/** コスト/能力の序列。大きいほど高コスト・高能力。 */
const MODEL_RANK: Record<string, number> = {
  [DEFAULT_LOW]: 1,
  [DEFAULT_MEDIUM]: 2,
  [DEFAULT_HIGH]: 3,
};

function rankOf(model: string): number {
  // 未知のモデルは medium 相当として扱い、上限判定で過剰に切り下げない。
  return MODEL_RANK[model] ?? 2;
}

/** per-task モデルルーティングが有効か（既定: 無効 = 現行挙動を維持）。 */
export function isTaskModelRoutingEnabled(): boolean {
  return process.env.TASK_MODEL_ROUTING === 'true';
}

/** complexity 文字列を安全に正規化する。不正値は undefined。 */
export function normalizeComplexity(value: unknown): TaskComplexity | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim().toLowerCase();
  if (v === 'low' || v === 'medium' || v === 'high') return v;
  return undefined;
}

/** complexity → モデル ID（環境変数で上書き可能）。 */
export function modelForComplexity(complexity: TaskComplexity): string {
  switch (complexity) {
    case 'low':
      return process.env.TASK_MODEL_LOW || DEFAULT_LOW;
    case 'high':
      return process.env.TASK_MODEL_HIGH || DEFAULT_HIGH;
    case 'medium':
    default:
      return process.env.TASK_MODEL_MEDIUM || DEFAULT_MEDIUM;
  }
}

/**
 * タスクに使う実装モデルを解決する。
 *
 * - ルーティング無効時は null を返す（呼び出し側は従来どおり env ベースのモデルを使う）。
 * - ユーザーが実装モデルを明示している場合はそれを「上限」として扱い、
 *   ルーティング結果がそれより高コストになることはない（トークン/コスト削減を優先）。
 *
 * @param complexity Planning が付与した複雑度（未設定なら medium 扱い）
 * @param userCeilingModel ユーザー選択の実装モデル（IMPLEMENTATION_CLAUDE_MODEL）。未指定なら上限なし。
 */
export function resolveTaskModel(
  complexity: TaskComplexity | undefined,
  userCeilingModel?: string
): string | null {
  if (!isTaskModelRoutingEnabled()) return null;

  const routed = modelForComplexity(complexity || 'medium');
  const ceiling = userCeilingModel?.trim();
  if (ceiling && rankOf(routed) > rankOf(ceiling)) {
    return ceiling;
  }
  return routed;
}
