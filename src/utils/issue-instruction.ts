import type { SourceIssue } from '../state/types.js';

export function buildIssueInstruction(issue: SourceIssue): string {
  const labels = issue.labels.length > 0 ? issue.labels.join(', ') : 'none';
  const body = issue.body.trim() || '(no body)';

  return [
    `GitHub Issue #${issue.number}: ${issue.title}`,
    `URL: ${issue.url}`,
    `Labels: ${labels}`,
    '',
    'Issue body:',
    body,
  ].join('\n');
}
