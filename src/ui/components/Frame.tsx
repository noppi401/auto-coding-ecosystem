import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';

interface Props {
  title?: string;
  subtitle?: string;
  right?: string;
  children: React.ReactNode;
}

export const Frame: React.FC<Props> = ({ title, subtitle, right, children }) => (
  <Box flexDirection="column" borderStyle="single" borderColor={theme.border}>
    {(title || subtitle || right) && (
      <Box paddingX={1} gap={1}>
        {title && <Text color={theme.accent} bold>{title}</Text>}
        {subtitle && <><Text color={theme.fgFaint}>·</Text><Text color={theme.fg}>{subtitle}</Text></>}
        {right && <><Text color={theme.fgFaint} dimColor>·</Text><Text color={theme.fgDim}>{right}</Text></>}
      </Box>
    )}
    {children}
  </Box>
);
