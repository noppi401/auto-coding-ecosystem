export interface Hunk {
  startLine: number;
  endLine: number;
  newLines: string[];
}

/**
 * 行番号指定の hunk を適用する（1 始まり・両端含む。endLine = startLine - 1 は挿入）。
 * 後ろの hunk から適用して、前の行番号がずれないようにする。
 */
export function applyHunks(original: string, hunks: Hunk[]): string {
  const lines = original.split('\n');
  const sorted = [...hunks].sort((a, b) => b.startLine - a.startLine);
  for (const hunk of sorted) {
    const start = Math.max(0, hunk.startLine - 1);
    const deleteCount = Math.max(0, hunk.endLine - hunk.startLine + 1);
    lines.splice(start, deleteCount, ...hunk.newLines);
  }
  return lines.join('\n');
}

/**
 * hunk が元ファイルの範囲内で、互いに重ならないことを確かめる。
 * 不正な hunk を applyHunks に渡すと黙って末尾に足されたり範囲が食い違うため、例外で可視化する。
 */
export function validateHunks(path: string, lineCount: number, hunks: Hunk[]): void {
  for (const h of hunks) {
    if (!Number.isInteger(h.startLine) || !Number.isInteger(h.endLine) || !Array.isArray(h.newLines)) {
      throw new Error(`Invalid hunk for "${path}": startLine/endLine must be integers and newLines an array.`);
    }
    if (h.newLines.some((l) => typeof l !== 'string')) {
      throw new Error(`Invalid hunk for "${path}": newLines must contain only strings.`);
    }
    const isInsert = h.endLine === h.startLine - 1;
    if (h.startLine < 1 || h.startLine > lineCount + 1 || (!isInsert && (h.endLine < h.startLine || h.endLine > lineCount))) {
      throw new Error(
        `Hunk for "${path}" is out of range: lines ${h.startLine}-${h.endLine} (file has ${lineCount} lines).`
      );
    }
  }
  const sorted = [...hunks].sort((a, b) => a.startLine - b.startLine);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (cur.startLine <= prev.endLine) {
      throw new Error(`Hunks for "${path}" overlap: ${prev.startLine}-${prev.endLine} and ${cur.startLine}-${cur.endLine}.`);
    }
  }
}
