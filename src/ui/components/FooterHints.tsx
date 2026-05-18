import React from 'react';
import { Box, Text } from 'ink';
import { theme, keyHints } from '../theme.js';

type Scope = keyof typeof keyHints;

interface Props {
  scope: Scope;
}

export const FooterHints: React.FC<Props> = ({ scope }) => (
  <Box paddingX={1} gap={2} borderTop borderStyle="single" borderColor={theme.border}>
    {keyHints[scope].map((h) => (
      <Box key={h.key} gap={1}>
        <Text color={theme.fgFaint}>{h.key}</Text>
        <Text color={theme.fgDim}>{h.desc}</Text>
      </Box>
    ))}
  </Box>
);
