import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import type { Task } from '../../state/types.js';

interface Props {
  tasks: Task[];
  width?: number;
}

export const ProgressBar: React.FC<Props> = ({ tasks, width = 28 }) => {
  if (tasks.length === 0) return null;

  const merged  = tasks.filter((t) => t.status === 'merged').length;
  const failed  = tasks.filter((t) => t.status === 'failed').length;
  const active  = tasks.filter((t) =>
    ['coding', 'pr_open', 'in_review', 'fixing'].includes(t.status)
  ).length;
  const total   = tasks.length;
  const pct     = Math.round((merged / total) * 100);

  const mergedW  = Math.round((merged  / total) * width);
  const failedW  = Math.round((failed  / total) * width);
  const activeW  = Math.round((active  / total) * width);
  const pendingW = Math.max(0, width - mergedW - failedW - activeW);

  return (
    <Box gap={1}>
      <Text>
        <Text color={theme.success}>{'█'.repeat(mergedW)}</Text>
        <Text color={theme.warning}>{'█'.repeat(activeW)}</Text>
        <Text color={theme.danger}>{'█'.repeat(failedW)}</Text>
        <Text color={theme.fgFaint}>{'░'.repeat(pendingW)}</Text>
      </Text>
      <Text color={theme.fg}>{pct}%</Text>
    </Box>
  );
};
