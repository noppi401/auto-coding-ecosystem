import type { Task } from '../state/types.js';
import { t } from './i18n.js';

/**
 * Issue #8: 要件定義・設計書をタスク関連部分に絞り込む決定論的抽出。
 *
 * モデルに非言語処理をさせない方針（CLAUDE.md 規約5）に従い、関連箇所の抽出は
 * キーワードマッチによる決定論的スコアリングで行う。全文ではなく関連セクションのみを
 * 実装エージェントへ渡すことで、タスク単位のトークン消費を削減する（Issue #8）。
 */

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'から', 'して', 'する', 'した',
  'いる', 'ため', 'こと', 'もの', 'よう', 'および', 'または', 'です', 'ます',
  'a', 'an', 'of', 'to', 'in', 'on', 'is', 'be', 'as', 'by', 'task', 'issue',
]);

/** per-task ドキュメント絞り込みが有効か（既定: 無効 = 現行挙動を維持）。 */
export function isDocRelevanceEnabled(): boolean {
  return process.env.IMPL_DOC_RELEVANCE === 'true';
}

/** タスクから検索キーワード集合を作る（タイトル・概要・対象ファイル名）。 */
export function buildTaskKeywords(task: Task): string[] {
  const fromText = `${task.title} ${task.summary}`
    .toLowerCase()
    .split(/[^a-z0-9ぁ-んァ-ヶ一-龠]+/i)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));

  const fromFiles = (task.targetFiles || []).flatMap((file) => {
    const normalized = file.replace(/\\/g, '/').toLowerCase();
    const base = normalized.split('/').pop() || normalized;
    const stem = base.replace(/\.[a-z0-9]+$/, '');
    // パスのディレクトリ要素とファイル名・拡張子なし語幹を候補にする
    return [
      ...normalized.split('/'),
      base,
      stem,
      ...stem.split(/[^a-z0-9]+/),
    ].filter((w) => w.length >= 3);
  });

  return [...new Set([...fromText, ...fromFiles])];
}

interface Section {
  index: number;
  text: string;
  score: number;
}

/** Markdown 見出し（#〜）でドキュメントをセクションに分割する。 */
function splitSections(doc: string): string[] {
  const lines = doc.split(/\r?\n/);
  const sections: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    if (/^#{1,6}\s/.test(line) && current.length > 0) {
      sections.push(current.join('\n'));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) sections.push(current.join('\n'));
  return sections.filter((s) => s.trim().length > 0);
}

function scoreSection(text: string, keywords: string[]): number {
  const lower = text.toLowerCase();
  const headingLine = (text.match(/^#{1,6}\s.*/m)?.[0] || '').toLowerCase();
  let score = 0;
  for (const kw of keywords) {
    if (!kw) continue;
    // セクション本文の出現回数
    let from = 0;
    while (true) {
      const idx = lower.indexOf(kw, from);
      if (idx === -1) break;
      score += 1;
      from = idx + kw.length;
    }
    // 見出しに含まれる場合は加点（関連度が高い）
    if (headingLine.includes(kw)) score += 3;
  }
  return score;
}

/**
 * ドキュメントから task に関連するセクションを抽出する。
 *
 * - ドキュメントが maxChars 以下なら全文を返す（絞り込み不要）。
 * - 関連スコアの高いセクションを予算内で選び、元の文書順で連結して返す。
 * - 関連セクションが一つも無い場合は先頭から maxChars 分にフォールバックする。
 */
export function extractRelevantDoc(
  doc: string,
  task: Task,
  maxChars: number
): string {
  if (!doc) return doc;
  if (doc.length <= maxChars) return doc;

  const keywords = buildTaskKeywords(task);
  const rawSections = splitSections(doc);
  const sections: Section[] = rawSections.map((text, index) => ({
    index,
    text,
    score: scoreSection(text, keywords),
  }));

  const relevant = sections.filter((s) => s.score > 0);
  if (relevant.length === 0) {
    return doc.slice(0, maxChars);
  }

  // スコア降順で予算まで採用 → 元の順序で連結して可読性を保つ
  const selected: Section[] = [];
  let used = 0;
  for (const section of [...relevant].sort((a, b) => b.score - a.score)) {
    if (used + section.text.length > maxChars && selected.length > 0) continue;
    selected.push(section);
    used += section.text.length;
    if (used >= maxChars) break;
  }

  const ordered = selected.sort((a, b) => a.index - b.index).map((s) => s.text);
  const omitted = rawSections.length - ordered.length;
  const note = omitted > 0
    ? t(`\n\n(注: タスク関連度の低い ${omitted} セクションは省略されています)`, `\n\n(Note: ${omitted} section(s) with low relevance to the task were omitted)`)
    : '';
  return ordered.join('\n\n').slice(0, maxChars) + note;
}
