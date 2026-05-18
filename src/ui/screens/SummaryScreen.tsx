import React, { useState } from 'react';
import { Box, Text, useApp } from 'ink';
import { theme, statusMeta } from '../theme.js';
import { useEcosystemState } from '../hooks/useEcosystemState.js';
import { useKeybinds } from '../hooks/useKeybinds.js';
import { ProgressBar } from '../components/ProgressBar.js';
import { FooterHints } from '../components/FooterHints.js';
import { LogStream } from '../components/LogStream.js';

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

interface Props {
  durationMs: number;
  onRestart: () => void;
}

export const SummaryScreen: React.FC<Props> = ({ durationMs, onRestart }) => {
  const { exit } = useApp();
  const { tasks, owner, repo, logs } = useEcosystemState();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [showLog, setShowLog] = useState(false);

  const merged  = tasks.filter((t) => t.status === 'merged').length;
  const failed  = tasks.filter((t) => t.status === 'failed').length;
  const skipped = tasks.filter((t) => t.status === 'pending').length;

  const dSec = Math.floor(durationMs / 1000);
  const dMin = Math.floor(dSec / 60);
  const duration = `${String(Math.floor(dMin / 60)).padStart(2, '0')}:${String(dMin % 60).padStart(2, '0')}:${String(dSec % 60).padStart(2, '0')}`;
  const quit = () => {
    exit();
    setTimeout(() => process.exit(0), 0);
  };

  useKeybinds({
    up:   () => setSelectedIndex((i) => Math.max(0, i - 1)),
    down: () => setSelectedIndex((i) => Math.min(tasks.length - 1, i + 1)),
    return: onRestart,
    l:     () => setShowLog((v) => !v),
    escape: () => setShowLog(false),
    q:    quit,
  });

  return (
    <Box flexDirection="column" height={process.stdout.rows}>
      {/* Header */}
      <Box paddingX={1} gap={1} borderBottom borderStyle="single" borderColor={theme.border}>
        <Text color={theme.accent} bold>▲ Session complete</Text>
        <Text color={theme.fgFaint}>·</Text>
        <Text color={theme.fg}>{owner}/{repo}</Text>
        <Text color={theme.fgFaint}>·</Text>
        <Text color={theme.fgDim}>duration {duration}</Text>
      </Box>

      {/* Stats */}
      <Box paddingX={2} paddingY={1} gap={4}>
        <Box gap={1}><Text color={theme.success} bold>{String(merged).padStart(3)}</Text><Text color={theme.success}>merged</Text></Box>
        <Box gap={1}><Text color={failed > 0 ? theme.danger : theme.fgFaint} bold>{String(failed).padStart(3)}</Text><Text color={theme.danger}>failed</Text></Box>
        <Box gap={1}><Text color={theme.fgFaint} bold>{String(skipped).padStart(3)}</Text><Text color={theme.fgFaint}>skipped</Text></Box>
      </Box>
      <Box paddingX={2}>
        <ProgressBar tasks={tasks} width={40} />
      </Box>

      {showLog ? (
        <Box flexDirection="column" paddingX={1} marginTop={1} borderTop borderStyle="single" borderColor={theme.border}>
          <LogStream logs={logs} visibleLines={Math.max(8, (process.stdout.rows ?? 24) - 8)} />
        </Box>
      ) : (
        <Box flexDirection="column" paddingX={1} marginTop={1} borderTop borderStyle="single" borderColor={theme.border}>
          <Box gap={2} paddingX={1}>
            <Text color={theme.fgDim}>{pad('#', 2)}</Text>
            <Text color={theme.fgDim}>{pad('TASK', 36)}</Text>
            <Text color={theme.fgDim}>{pad('STATUS', 14)}</Text>
            <Text color={theme.fgDim}>{pad('PR', 5)}</Text>
            <Text color={theme.fgDim}>{pad('ISSUE', 5)}</Text>
            <Text color={theme.fgDim}>ITER</Text>
          </Box>
          {tasks.map((task, i) => {
            const meta = statusMeta[task.status];
            const focused = i === selectedIndex;
            return (
              <Box key={task.id} flexDirection="column">
                <Box gap={2} paddingX={1}>
                  <Text color={focused ? theme.accent : theme.fgFaint}>{pad(String(i + 1), 2)}</Text>
                  <Text color={focused ? theme.fg : theme.fgMute}>{pad(truncate(task.title, 36), 36)}</Text>
                  <Text color={meta.color}>{pad(`${meta.icon} ${task.status}`, 14)}</Text>
                  <Text color={theme.info}>{pad(task.prNumber ? `#${task.prNumber}` : '-', 5)}</Text>
                  <Text color={theme.info}>{pad(task.issueNumber ? `#${task.issueNumber}` : '-', 5)}</Text>
                  <Text color={task.reviewIteration >= 5 ? theme.danger : theme.fgFaint}>
                    {task.reviewIteration > 0 ? `${task.reviewIteration}/5` : '-'}
                  </Text>
                </Box>
                {task.status === 'failed' && task.errorMessage && focused && (
                  <Box paddingLeft={4}>
                    <Text color={theme.danger} wrap="wrap">{truncate(task.errorMessage, 140)}</Text>
                  </Box>
                )}
              </Box>
            );
          })}
        </Box>
      )}

      {/* Repo link */}
      {repo && (
        <Box paddingX={1} marginTop={1} gap={1}>
          <Text color={theme.fgDim}>REPOSITORY</Text>
          <Text color={theme.info}>https://github.com/{owner}/{repo}</Text>
        </Box>
      )}

      <FooterHints scope={showLog ? 'log' : 'summary'} />
    </Box>
  );
};
