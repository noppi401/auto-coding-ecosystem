import { logger } from './logger.js';

/**
 * maxChars（数値または env 文字列）を超える部分を切り詰め、切り詰めた場合は警告ログを出す。
 * maxChars が未指定・不正値なら全文を返す。
 */
export function truncateWithWarning(text: string, maxChars: number | string | undefined, label: string): string {
  const max = Number(maxChars);
  if (!maxChars || !Number.isFinite(max) || max <= 0 || text.length <= max) return text;
  logger.warn(`${label} truncated; content beyond the limit is not sent to the LLM`, `${text.length} -> ${max} chars`);
  return text.substring(0, max);
}
