import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { theme, statusMeta } from '../theme.js';
import type { Task } from '../../state/types.js';
import { t } from '../../utils/i18n.js';

interface Props {
  task: Task | null;
  taskIndex: number;
  totalTasks: number;
  hideError?: boolean;
}

export const CurrentTaskCard: React.FC<Props> = ({ task, taskIndex, totalTasks, hideError }) => {
  if (!task) {
    return (
      <Box flexDirection="column" paddingX={1} paddingY={0} borderBottom borderStyle="single" borderColor={theme.border}>
        <Text color={theme.fgDim}>CURRENT TASK</Text>
        <Text color={theme.fgFaint}>{t('待機中...', 'Waiting...')}</Text>
      </Box>
    );
  }

  const meta = statusMeta[task.status];
  const isSpinning = meta.spinning;

  return (
    <Box flexDirection="column" paddingX={1} paddingY={0} borderBottom borderStyle="single" borderColor={theme.border}>
      <Box gap={1}>
        <Text color={theme.fgDim}>CURRENT TASK</Text>
      </Box>
      <Box gap={1} marginTop={0}>
        <Text color={theme.fg} bold>Task {taskIndex + 1} / {totalTasks}</Text>
        <Text color={theme.fgFaint}>·</Text>
        <Text color={theme.fg} bold>{task.title}</Text>
      </Box>
      <Box gap={2} marginTop={0}>
        <Box gap={1}>
          <Text color={theme.fgDim}>Status  </Text>
          <Text color={meta.color}>
            {isSpinning ? <Spinner type="dots" /> : meta.icon}
            {' '}{meta.label}
          </Text>
        </Box>
        {task.reviewIteration > 0 && (
          <Box gap={1}>
            <Text color={theme.fgDim}>Review</Text>
            <Text color={theme.warning}>{task.reviewIteration}/5</Text>
          </Box>
        )}
      </Box>
      <Box gap={2}>
        {task.prNumber && (
          <Box gap={1}>
            <Text color={theme.fgDim}>PR    </Text>
            <Text color={theme.info}>#{task.prNumber}</Text>
          </Box>
        )}
        {task.issueNumber && (
          <Box gap={1}>
            <Text color={theme.fgDim}>Issue</Text>
            <Text color={theme.info}>#{task.issueNumber}</Text>
          </Box>
        )}
      </Box>
      {task.branchName && (
        <Box gap={1}>
          <Text color={theme.fgDim}>Branch  </Text>
          <Text color={theme.fg}>{task.branchName}</Text>
        </Box>
      )}
      {task.status === 'failed' && task.errorMessage && !hideError && (
        <Box marginTop={1} paddingLeft={1} borderLeft borderStyle="single" borderColor={theme.danger}>
          <Text color={theme.danger} wrap="wrap">{task.errorMessage.slice(0, 200)}</Text>
        </Box>
      )}
    </Box>
  );
};
