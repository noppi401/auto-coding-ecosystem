export interface TestFailureSummary {
  failedFiles: string[];
  failedTests: Array<{ name: string; error: string }>;
  totalFailed: number;
}

export function parseTestOutput(output: string): TestFailureSummary {
  const failedFiles: string[] = [];
  const failedTests: Array<{ name: string; error: string }> = [];

  // Detect failed test files — Jest/Vitest output: "FAIL src/__tests__/foo.test.ts"
  const failFileRegex = /\bFAIL\b\s+(.+\.(?:test|spec)\.[jt]sx?)/gm;
  let fileMatch;
  while ((fileMatch = failFileRegex.exec(output)) !== null) {
    const filePath = fileMatch[1].trim();
    if (!failedFiles.includes(filePath)) {
      failedFiles.push(filePath);
    }
  }

  // Detect failing test names — Jest "● describe > it" or Vitest "✕ / × / AssertionError" lines
  const lines = output.split('\n');
  let currentTest = '';
  let errorBuffer: string[] = [];

  const flush = () => {
    if (!currentTest) return;
    failedTests.push({
      name: currentTest,
      error: errorBuffer.filter(l => l.trim()).slice(0, 6).join('\n').trim(),
    });
    currentTest = '';
    errorBuffer = [];
  };

  for (const line of lines) {
    const bulletMatch = line.match(/^\s+[●•✕×✗]\s+(.+)$/);
    if (bulletMatch) {
      flush();
      currentTest = bulletMatch[1].trim();
    } else if (currentTest) {
      if (line.trim()) errorBuffer.push(line);
    }
  }
  flush();

  const countMatch = output.match(/(\d+)\s+(?:test(?:s)?\s+)?failed/i);
  const totalFailed = countMatch
    ? parseInt(countMatch[1], 10)
    : Math.max(failedTests.length, failedFiles.length);

  return { failedFiles, failedTests, totalFailed };
}

export function formatTestFailureComment(summary: TestFailureSummary, rawOutput: string): string {
  if (summary.failedFiles.length === 0 && summary.failedTests.length === 0) {
    return rawOutput.slice(0, 3000);
  }

  const parts: string[] = [`**${summary.totalFailed} 件のテストが失敗しました**`];

  if (summary.failedFiles.length > 0) {
    parts.push(`\n**失敗ファイル:**`);
    summary.failedFiles.forEach(f => parts.push(`- \`${f}\``));
  }

  if (summary.failedTests.length > 0) {
    const showTests = summary.failedTests.slice(0, 8);
    parts.push(`\n**失敗テスト:**`);
    showTests.forEach(t => {
      parts.push(`\n**${t.name}**`);
      if (t.error) parts.push(`\`\`\`\n${t.error.slice(0, 400)}\n\`\`\``);
    });
    if (summary.failedTests.length > 8) {
      parts.push(`\n*...他 ${summary.failedTests.length - 8} 件*`);
    }
  }

  return parts.join('\n');
}
