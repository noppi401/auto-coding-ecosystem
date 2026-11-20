/**
 * Issue #6: PR diff のサイズ上限・トリミング。
 *
 * レビュー/修正の各反復で PR 全文 diff を LLM に渡すとトークンを浪費する。
 * レビュー不要な巨大ファイル（lockfile 等）を除外し、全体を文字数上限でトリミングする。
 * トリミングは決定論的に行い、省略箇所は明示する（CLAUDE.md 規約12: 失敗/省略の可視化）。
 */

import { t } from './i18n.js';

const DEFAULT_MAX_CHARS = 30000;
const DEFAULT_EXCLUDE = 'package-lock.json,pnpm-lock.yaml,yarn.lock';

/** `diff --git a/... b/...` 単位で diff をファイルブロックに分割する。 */
function splitFileBlocks(diff: string): string[] {
  const blocks: string[] = [];
  const lines = diff.split(/\r?\n/);
  let current: string[] = [];

  for (const line of lines) {
    if (line.startsWith('diff --git ') && current.length > 0) {
      blocks.push(current.join('\n'));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) blocks.push(current.join('\n'));
  return blocks;
}

/** ブロック先頭の `diff --git a/<path> b/<path>` から対象パスを取り出す。 */
function pathOfBlock(block: string): string | null {
  const match = block.match(/^diff --git a\/(.+?) b\//m);
  return match ? match[1] : null;
}

function getMaxChars(): number {
  const raw = process.env.PR_DIFF_MAX_CHARS;
  if (raw === undefined) return DEFAULT_MAX_CHARS;
  const n = Number(raw);
  return Number.isFinite(n) ? n : DEFAULT_MAX_CHARS;
}

function getExcludeNames(): string[] {
  const raw = process.env.PR_DIFF_EXCLUDE ?? DEFAULT_EXCLUDE;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * PR diff を除外リストと文字数上限でトリミングする。
 *
 * - 除外対象ファイル（既定: lockfile）のブロックを取り除く。
 * - 残りが上限を超える場合、収まる範囲のブロックのみ残し、省略を末尾に明示する。
 * - PR_DIFF_MAX_CHARS=0 で文字数トリミングを無効化できる（除外のみ実施）。
 */
export function trimPrDiff(diff: string): string {
  if (!diff) return diff;

  const maxChars = getMaxChars();
  const excludeNames = getExcludeNames();
  const blocks = splitFileBlocks(diff);

  const kept: string[] = [];
  const excludedFiles: string[] = [];
  for (const block of blocks) {
    const path = pathOfBlock(block);
    const base = path ? path.split('/').pop() || path : null;
    if (base && excludeNames.includes(base)) {
      excludedFiles.push(path!);
      continue;
    }
    kept.push(block);
  }

  const notes: string[] = [];
  if (excludedFiles.length > 0) {
    notes.push(t(`(注: レビュー対象外として除外: ${excludedFiles.join(', ')})`, `(Note: excluded from review: ${excludedFiles.join(', ')})`));
  }

  let body = kept.join('\n');

  if (maxChars > 0 && body.length > maxChars) {
    const truncatedBlocks: string[] = [];
    let used = 0;
    let omitted = 0;
    for (const block of kept) {
      if (used + block.length > maxChars && truncatedBlocks.length > 0) {
        omitted++;
        continue;
      }
      truncatedBlocks.push(block);
      used += block.length + 1;
    }
    body = truncatedBlocks.join('\n');
    if (body.length > maxChars) {
      body = body.slice(0, maxChars);
    }
    notes.push(
      t(
        `(注: PR diff が上限 ${maxChars} 文字を超えたためトリミングしました${omitted > 0 ? `。${omitted} ファイルブロックを省略` : ''})`,
        `(Note: the PR diff exceeded the ${maxChars}-character limit and was trimmed${omitted > 0 ? `; ${omitted} file block(s) omitted` : ''})`
      )
    );
  }

  return notes.length > 0 ? `${body}\n\n${notes.join('\n')}` : body;
}
