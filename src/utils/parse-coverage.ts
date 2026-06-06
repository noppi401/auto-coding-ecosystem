export interface CoverageSummary {
  lines: number;
  branches: number;
  functions: number;
  statements: number;
}

export function parseCoverageOutput(output: string): CoverageSummary | null {
  // Istanbul / c8 / v8 text-summary format:
  //   Lines   : 72.34% ( 123/170 )
  //   Branches: 60.00% ( 30/50 )
  const linesMatch = output.match(/Lines\s*:\s*([\d.]+)%/i);
  const branchesMatch = output.match(/Branches\s*:\s*([\d.]+)%/i);
  const functionsMatch = output.match(/Functions\s*:\s*([\d.]+)%/i);
  const statementsMatch = output.match(/Statements\s*:\s*([\d.]+)%/i);

  if (!linesMatch && !statementsMatch) return null;

  return {
    lines: linesMatch ? parseFloat(linesMatch[1]) : 0,
    branches: branchesMatch ? parseFloat(branchesMatch[1]) : 0,
    functions: functionsMatch ? parseFloat(functionsMatch[1]) : 0,
    statements: statementsMatch ? parseFloat(statementsMatch[1]) : 0,
  };
}

export function formatCoverageComment(
  summary: CoverageSummary,
  lineThreshold: number,
  branchThreshold: number
): string {
  const lineOk = summary.lines >= lineThreshold;
  const branchOk = summary.branches >= branchThreshold;

  const rows = [
    `| 指標 | 実測値 | 閾値 | 結果 |`,
    `|------|--------|------|------|`,
    `| Lines | ${summary.lines.toFixed(1)}% | ${lineThreshold}% | ${lineOk ? '✓' : '✗'} |`,
    `| Branches | ${summary.branches.toFixed(1)}% | ${branchThreshold}% | ${branchOk ? '✓' : '✗'} |`,
    `| Functions | ${summary.functions.toFixed(1)}% | - | - |`,
    `| Statements | ${summary.statements.toFixed(1)}% | - | - |`,
  ].join('\n');

  const header = lineOk && branchOk
    ? '**カバレッジ: 閾値クリア**'
    : '**カバレッジ: 閾値未満**（テストを追加してカバレッジを改善してください）';

  return `${header}\n\n${rows}`;
}
