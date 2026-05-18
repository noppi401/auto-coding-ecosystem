import React from 'react';
import { Text } from 'ink';
import Spinner from 'ink-spinner';
import { statusMeta } from '../theme.js';
import type { TaskStatus } from '../../state/types.js';

interface Props {
  status: TaskStatus;
  showLabel?: boolean;
}

export const StatusBadge: React.FC<Props> = ({ status, showLabel = false }) => {
  const meta = statusMeta[status];
  return (
    <Text color={meta.color}>
      {meta.spinning ? <Spinner type="dots" /> : meta.icon}
      {showLabel && <Text color={meta.color}> {meta.label}</Text>}
    </Text>
  );
};
