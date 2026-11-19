/**
 * 大きな依頼文（要件 md）をカテゴリ別に要件定義するための決定論ロジック。
 * 規模判断と見出し分割はコードで行い、LLM は見出しがない場合の分割提案にだけ使う。
 */

export interface RequirementsCategory {
  title: string;
  content: string;
}

export interface RequirementsSplitDecision {
  shouldSplit: boolean;
  reason: string;
}

export interface LineRange {
  title: string;
  startLine: number;
  endLine: number;
}

export function decideRequirementsSplit(
  instruction: string,
  env: NodeJS.ProcessEnv = process.env
): RequirementsSplitDecision {
  const mode = (env.REQ_SPLIT_MODE || 'auto').toLowerCase();
  if (mode === 'never') return { shouldSplit: false, reason: 'REQ_SPLIT_MODE=never' };
  if (mode === 'always') return { shouldSplit: true, reason: 'REQ_SPLIT_MODE=always' };

  const parsed = Number.parseInt(env.REQ_SPLIT_CHARS || '', 10);
  const threshold = Number.isFinite(parsed) && parsed > 0 ? parsed : 8000;
  return instruction.length >= threshold
    ? { shouldSplit: true, reason: `instruction chars ${instruction.length} >= ${threshold}` }
    : { shouldSplit: false, reason: `instruction chars ${instruction.length} < ${threshold}` };
}

/**
 * 2回以上現れる最も浅い見出しレベルでカテゴリに分ける（コードブロック内の # は無視）。
 * 最初の見出しより前（タイトル・前書き）は preamble として各カテゴリの共通文脈にする。
 * カテゴリが2つ未満なら null。
 */
export function splitByHeadings(
  text: string
): { preamble: string; categories: RequirementsCategory[] } | null {
  const lines = text.split(/\r?\n/);
  const headings: Array<{ index: number; level: number; title: string }> = [];
  let inFence = false;

  lines.forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (inFence) return;
    const match = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (match) headings.push({ index, level: match[1].length, title: match[2] });
  });

  const counts = new Map<number, number>();
  for (const heading of headings) counts.set(heading.level, (counts.get(heading.level) ?? 0) + 1);
  const level = [...counts.keys()].sort((a, b) => a - b).find((l) => (counts.get(l) ?? 0) >= 2);
  if (level === undefined) return null;

  const splitPoints = headings.filter((heading) => heading.level === level);
  const categories = splitPoints.map((heading, i) => ({
    title: heading.title,
    content: lines.slice(heading.index, splitPoints[i + 1]?.index ?? lines.length).join('\n').trim(),
  }));

  return {
    preamble: lines.slice(0, splitPoints[0].index).join('\n').trim(),
    categories,
  };
}

/**
 * LLM が提案した行範囲（1始まり・両端含む）で原文を切り出す。
 * 範囲が全行を隙間・重複なく順に覆っていない場合は null（内容の欠落を防ぐため）。
 */
export function sliceByLineRanges(text: string, ranges: LineRange[]): RequirementsCategory[] | null {
  const lines = text.split(/\r?\n/);
  if (ranges.length < 2) return null;

  let expectedStart = 1;
  for (const range of ranges) {
    if (
      !Number.isInteger(range.startLine) ||
      !Number.isInteger(range.endLine) ||
      range.startLine !== expectedStart ||
      range.endLine < range.startLine
    ) {
      return null;
    }
    expectedStart = range.endLine + 1;
  }
  if (expectedStart !== lines.length + 1) return null;

  return ranges.map((range) => ({
    title: String(range.title || `Category ${range.startLine}-${range.endLine}`),
    content: lines.slice(range.startLine - 1, range.endLine).join('\n').trim(),
  }));
}
