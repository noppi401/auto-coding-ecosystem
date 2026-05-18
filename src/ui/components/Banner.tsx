import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';

type Kind = 'info' | 'warn' | 'error' | 'auth';

const kindMeta: Record<Kind, { icon: string; color: string; label: string }> = {
  info:  { icon: 'ℹ', color: theme.info,    label: 'INFO'   },
  warn:  { icon: '⚠', color: theme.warning, label: 'WARN'   },
  error: { icon: '✗', color: theme.danger,  label: 'ERROR'  },
  auth:  { icon: '⚠', color: theme.warning, label: 'ACTION REQUIRED' },
};

interface Props {
  kind: Kind;
  title?: string;
  message: string;
  command?: string;
}

export const Banner: React.FC<Props> = ({ kind, title, message, command }) => {
  const meta = kindMeta[kind];
  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={meta.color}
      paddingX={1}
      marginY={0}
    >
      <Box gap={1}>
        <Text color={meta.color} bold>{meta.icon} {title ?? meta.label}</Text>
      </Box>
      <Text color={theme.fgMute} wrap="wrap">{message}</Text>
      {command && (
        <Box marginTop={1} paddingX={1} borderLeft borderStyle="single" borderColor={theme.border}>
          <Text color={theme.fg}>{command}</Text>
        </Box>
      )}
    </Box>
  );
};
