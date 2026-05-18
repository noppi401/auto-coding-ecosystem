import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import type { LogEvent } from '../../events.js';

const SOURCE_COLORS: Record<string, string> = {
  agent:  theme.special,
  github: theme.info,
  coding: theme.warning,
  review: theme.review,
  queue:  theme.success,
  error:  theme.danger,
  warn:   theme.warning,
  info:   theme.fgDim,
};

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('ja-JP', { hour12: false });
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

interface Props {
  logs: LogEvent[];
  visibleLines?: number;
  searchTerm?: string;
}

export const LogStream: React.FC<Props> = ({ logs, visibleLines = 10, searchTerm }) => {
  const filtered = searchTerm
    ? logs.filter((l) => l.message.toLowerCase().includes(searchTerm.toLowerCase()))
    : logs;

  const visible = filtered.slice(-visibleLines);

  return (
    <Box flexDirection="column" paddingX={1} flexGrow={1}>
      <Text color={theme.fgDim} bold>LOG</Text>
      {visible.length === 0 && (
        <Text color={theme.fgFaint}>ログ待機中...</Text>
      )}
      {visible.map((ev, i) => (
        <Box key={i} gap={1}>
          <Text color={theme.fgFaint}>[{formatTime(ev.ts)}]</Text>
          <Text color={SOURCE_COLORS[ev.source] ?? theme.fgDim}>
            {ev.source.padEnd(8)}
          </Text>
          <Text color={ev.level === 'error' ? theme.danger : ev.level === 'warn' ? theme.warning : theme.fgMute}>
            {truncate(ev.message, 80)}
          </Text>
        </Box>
      ))}
    </Box>
  );
};
