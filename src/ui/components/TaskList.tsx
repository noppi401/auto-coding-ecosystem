import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import { TaskRow } from './TaskRow.js';
import { ProgressBar } from './ProgressBar.js';
import type { Task } from '../../state/types.js';

interface Props {
  tasks: Task[];
  focusedIndex: number;
  expandedTaskId: string | null;
}

export const TaskList: React.FC<Props> = ({ tasks, focusedIndex, expandedTaskId }) => {
  const merged = tasks.filter((t) => t.status === 'merged').length;
  const failed = tasks.filter((t) => t.status === 'failed').length;
  const skipped = tasks.filter((t) => t.status === 'skipped').length;

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box paddingX={1} paddingY={0}>
        <Text color={theme.fgDim} bold>TASKS</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        {tasks.map((task, i) => (
          <TaskRow
            key={task.id}
            task={task}
            index={i}
            focused={i === focusedIndex}
            expanded={task.id === expandedTaskId}
          />
        ))}
      </Box>
      <Box flexDirection="column" paddingX={1} marginTop={1} gap={0}>
        <Box gap={2}>
          <Text color={theme.fgDim}>Merged </Text>
          <Text color={theme.success} bold>{merged}</Text>
          <Text color={theme.fgFaint}>/ {tasks.length}</Text>
        </Box>
        <Box gap={2}>
          <Text color={theme.fgDim}>Failed </Text>
          <Text color={failed > 0 ? theme.danger : theme.fgFaint} bold={failed > 0}>{failed}</Text>
          <Text color={theme.fgFaint}>/ {tasks.length}</Text>
        </Box>
        <Box gap={2}>
          <Text color={theme.fgDim}>Skipped</Text>
          <Text color={skipped > 0 ? theme.fgDim : theme.fgFaint} bold={skipped > 0}>{skipped}</Text>
          <Text color={theme.fgFaint}>/ {tasks.length}</Text>
        </Box>
      </Box>
      <Box paddingX={1} marginTop={1}>
        <ProgressBar tasks={tasks} />
      </Box>
    </Box>
  );
};
