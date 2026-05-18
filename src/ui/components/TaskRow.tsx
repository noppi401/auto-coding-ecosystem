import React from 'react';
import { Box, Text } from 'ink';
import { theme, statusMeta } from '../theme.js';
import { StatusBadge } from './StatusBadge.js';
import type { Task } from '../../state/types.js';

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

interface Props {
  task: Task;
  index: number;
  focused: boolean;
  expanded?: boolean;
}

export const TaskRow: React.FC<Props> = ({ task, index, focused, expanded }) => {
  const meta = statusMeta[task.status];
  return (
    <Box flexDirection="column">
      <Box paddingX={1} gap={1}>
        <Text color={focused ? theme.accent : theme.fgFaint}>{focused ? '▸' : ' '}</Text>
        <StatusBadge status={task.status} />
        <Text color={theme.fgFaint}>{String(index + 1).padStart(2)}</Text>
        <Text color={focused ? theme.fg : theme.fgDim} bold={focused}>
          {truncate(task.title, 26)}
        </Text>
        {task.status === 'failed' && <Text color={theme.danger}> !</Text>}
        {task.reviewIteration > 0 && task.status === 'in_review' && (
          <Text color={theme.fgFaint}> {task.reviewIteration}/5</Text>
        )}
      </Box>
      {expanded && task.status === 'failed' && task.errorMessage && (
        <Box paddingLeft={5}>
          <Text color={theme.danger} wrap="wrap">
            {task.errorMessage.slice(0, 120)}
          </Text>
        </Box>
      )}
    </Box>
  );
};
