import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import type { Task, TaskCheckResult } from '../../state/types.js';
import { t } from '../../utils/i18n.js';

interface Action {
  key: string;
  label: string;
  hint: string;
  primary?: boolean;
}

interface Props {
  task: Task;
  onRetry?: () => void;
  onRetryWithOpus?: () => void;
  onSkip?: () => void;
  onOpenPr?: () => void;
}

export function visibleTaskChecks(task: Task): TaskCheckResult[] {
  return (task.lastChecks ?? [])
    .filter((check) => check.status !== 'passed')
    .slice(-4);
}

function checkColor(check: TaskCheckResult): string {
  if (check.status === 'failed') return theme.danger;
  if (check.status === 'warning') return theme.warning;
  if (check.status === 'skipped') return theme.fgFaint;
  return theme.success;
}

export const RecoveryMenu: React.FC<Props> = ({
  task,
  onRetry,
  onRetryWithOpus,
  onSkip,
  onOpenPr,
}) => {
  const actions: Action[] = [
    { key: 'r', label: 'Retry (+3 iterations)',      hint: t('同じモデルで再試行', 'Retry with the same model'),  primary: true },
    { key: 'R', label: 'Retry with opus-4',          hint: t('モデル昇格して再試行', 'Retry with upgraded model')              },
    { key: 's', label: 'Skip and continue queue',    hint: t('次のタスクへ', 'Move to next task')                              },
    ...(task.prNumber ? [{ key: 'o', label: `Open PR #${task.prNumber} in browser`, hint: t('手動対応', 'Handle manually') }] : []),
  ];

  return (
    <Box flexDirection="column" paddingX={1} marginTop={1}>
      <Text color={theme.fgDim} bold>RECOVERY OPTIONS</Text>
      <Box flexDirection="column" marginTop={0}>
        {actions.map((a) => (
          <Box key={a.key} gap={2}>
            <Box
              paddingX={1}
              borderStyle="single"
              borderColor={a.primary ? theme.accent : theme.border}
            >
              <Text color={a.primary ? theme.accent : theme.fg} bold={a.primary}>{a.key}</Text>
            </Box>
            <Text color={a.primary ? theme.fg : theme.fgMute}>{a.label}</Text>
            <Text color={theme.fgFaint}>{a.hint}</Text>
          </Box>
        ))}
      </Box>
      {visibleTaskChecks(task).length > 0 && (
        <Box marginTop={1} paddingLeft={1} flexDirection="column" borderLeft borderStyle="single" borderColor={theme.warning}>
          <Text color={theme.fgDim} bold>LAST CHECKS</Text>
          {visibleTaskChecks(task).map((check) => (
            <Text key={`${check.name}-${check.updatedAt}`} color={checkColor(check)} wrap="wrap">
              {check.name}: {check.status} - {check.summary}
            </Text>
          ))}
        </Box>
      )}
      {task.errorMessage && (
        <Box marginTop={1} paddingLeft={1} borderLeft borderStyle="single" borderColor={theme.danger}>
          <Text color={theme.danger} wrap="wrap">
            {task.errorMessage.slice(0, 300)}
          </Text>
        </Box>
      )}
    </Box>
  );
};
