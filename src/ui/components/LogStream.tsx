import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import type { LogEvent } from '../../events.js';
import { t } from '../../utils/i18n.js';

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
  levelFilter?: LogEvent['level'][];
  sourceFilter?: LogEvent['source'][];
  scrollOffset?: number;
  follow?: boolean;
  statusItems?: string[];
}

export interface LogStreamViewOptions {
  visibleLines?: number;
  searchTerm?: string;
  levelFilter?: LogEvent['level'][];
  sourceFilter?: LogEvent['source'][];
  scrollOffset?: number;
  follow?: boolean;
}

export function filterLogEvents(
  logs: LogEvent[],
  options: Pick<LogStreamViewOptions, 'searchTerm' | 'levelFilter' | 'sourceFilter'> = {}
): LogEvent[] {
  const normalizedSearch = options.searchTerm?.trim().toLowerCase();
  return logs.filter((log) => {
    if (normalizedSearch && !log.message.toLowerCase().includes(normalizedSearch)) {
      return false;
    }
    if (options.levelFilter && !options.levelFilter.includes(log.level)) {
      return false;
    }
    if (options.sourceFilter && !options.sourceFilter.includes(log.source)) {
      return false;
    }
    return true;
  });
}

export function getLogStreamView(
  logs: LogEvent[],
  options: LogStreamViewOptions = {}
): { filtered: LogEvent[]; visible: LogEvent[]; start: number; end: number } {
  const visibleLines = options.visibleLines ?? 10;
  const filtered = filterLogEvents(logs, options);
  const offset = options.follow === false ? Math.max(0, options.scrollOffset ?? 0) : 0;
  const end = Math.max(0, filtered.length - offset);
  const start = Math.max(0, end - visibleLines);
  return {
    filtered,
    visible: filtered.slice(start, end),
    start,
    end,
  };
}

export const LogStream: React.FC<Props> = ({
  logs,
  visibleLines = 10,
  searchTerm,
  levelFilter,
  sourceFilter,
  scrollOffset = 0,
  follow = true,
  statusItems = [],
}) => {
  const view = getLogStreamView(logs, {
    visibleLines,
    searchTerm,
    levelFilter,
    sourceFilter,
    scrollOffset,
    follow,
  });

  return (
    <Box flexDirection="column" paddingX={1} flexGrow={1}>
      <Box gap={1}>
        <Text color={theme.fgDim} bold>LOG</Text>
        {statusItems.map((item) => (
          <Text key={item} color={theme.fgFaint}>· {item}</Text>
        ))}
        <Text color={theme.fgFaint}>
          {view.filtered.length === 0 ? '0/0' : `${view.start + 1}-${view.end}/${view.filtered.length}`}
        </Text>
      </Box>
      {view.visible.length === 0 && (
        <Text color={theme.fgFaint}>{t('ログ待機中...', 'Waiting for logs...')}</Text>
      )}
      {view.visible.map((ev, i) => (
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
