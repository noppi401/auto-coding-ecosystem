import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text, useApp, useStdout } from 'ink';
import { theme } from '../theme.js';
import { useEcosystemState } from '../hooks/useEcosystemState.js';
import { useKeybinds } from '../hooks/useKeybinds.js';
import { TaskList } from '../components/TaskList.js';
import { CurrentTaskCard } from '../components/CurrentTaskCard.js';
import { LogStream } from '../components/LogStream.js';
import { RecoveryMenu } from '../components/RecoveryMenu.js';
import { FooterHints } from '../components/FooterHints.js';
import { Orchestrator } from '../../orchestrator.js';
import { StateManager } from '../../state/manager.js';
import type { Task } from '../../state/types.js';

function elapsed(startMs: number): string {
  const s = Math.floor((Date.now() - startMs) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

interface Props {
  runFn: () => Promise<void>;
  onComplete: () => void;
}

export const RunScreen: React.FC<Props> = ({ runFn, onComplete }) => {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const ecoState = useEcosystemState();

  const [focusedIndex, setFocusedIndex]     = useState(0);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [showLog, setShowLog]               = useState(false);
  const [isPaused, setIsPaused]             = useState(false);
  const [startMs]                           = useState(Date.now());
  const [tick, setTick]                     = useState(0);
  const [runError, setRunError]             = useState<string | null>(null);
  const [phase2Started, setPhase2Started]   = useState(false);
  const [orchestratorRunning, setOrchestratorRunning] = useState(false);

  // elapsed timer
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  // タスク失敗時は onComplete を呼ばず RunScreen を維持する
  const finishRun = useCallback(async () => {
    const manager = new StateManager();
    const s = await manager.load();
    const hasFailed = s?.tasks.some((t) => t.status === 'failed') ?? false;
    setOrchestratorRunning(false);
    if (!hasFailed) onComplete();
  }, [onComplete]);

  // start orchestrator
  useEffect(() => {
    setOrchestratorRunning(true);
    runFn().then(finishRun).catch((err: Error) => {
      setOrchestratorRunning(false);
      setRunError(err.message);
    });
  }, []);

  const tasks = ecoState.tasks;
  const currentTask: Task | null = tasks[ecoState.currentTaskIndex] ?? null;
  const focusedTask: Task | null = tasks[focusedIndex] ?? null;

  const openPr = useCallback((task: Task | null) => {
    if (!task?.prUrl) return;
    const { execSync } = require('child_process');
    try { execSync(`start "" "${task.prUrl}"`); } catch { /* ignore */ }
  }, []);

  const quit = useCallback(() => {
    exit();
    setTimeout(() => process.exit(0), 0);
  }, [exit]);

  const launchPhase2 = useCallback((retryFailed: boolean, opusModel?: string) => {
    if (orchestratorRunning) return;
    setOrchestratorRunning(true);
    if (opusModel) {
      process.env.IMPLEMENTATION_CLAUDE_MODEL = opusModel;
    }
    const orch = new Orchestrator();
    orch.runPhase2(retryFailed).then(finishRun).catch((err: Error) => {
      setOrchestratorRunning(false);
      setRunError(err.message);
    });
  }, [orchestratorRunning, finishRun]);

  const startPhase2 = useCallback(() => {
    if (phase2Started) return;
    setPhase2Started(true);
    launchPhase2(false);
  }, [phase2Started, launchPhase2]);

  const retryFocusedTask = useCallback(async (useOpus: boolean) => {
    const task = focusedTask;
    if (!task || task.status !== 'failed' || orchestratorRunning) return;
    setExpandedTaskId(null);
    const manager = new StateManager();
    await manager.updateTask(task.id, { status: 'pending', errorMessage: undefined, reviewIteration: 0 });
    launchPhase2(true, useOpus ? 'claude-opus-4-7' : undefined);
  }, [focusedTask, orchestratorRunning, launchPhase2]);

  const skipFocusedTask = useCallback(async () => {
    const task = focusedTask;
    if (!task || task.status !== 'failed' || orchestratorRunning) return;
    setExpandedTaskId(null);
    const manager = new StateManager();
    await manager.updateTask(task.id, { status: 'merged', errorMessage: undefined });
    launchPhase2(false);
  }, [focusedTask, orchestratorRunning, launchPhase2]);

  const inRecovery = !orchestratorRunning &&
    focusedTask?.status === 'failed' &&
    expandedTaskId === focusedTask?.id;

  useKeybinds({
    up:     () => setFocusedIndex((i) => Math.max(0, i - 1)),
    down:   () => setFocusedIndex((i) => Math.min(tasks.length - 1, i + 1)),
    return: () => {
      if (ecoState.phase === 'awaiting_approval' && !phase2Started) {
        startPhase2();
        return;
      }
      const id = focusedTask?.id ?? null;
      setExpandedTaskId((prev) => (prev === id ? null : id));
    },
    l: () => setShowLog((v) => !v),
    p: () => setIsPaused((v) => !v),
    o: () => openPr(focusedTask),
    r: () => { if (inRecovery) void retryFocusedTask(false); },
    R: () => { if (inRecovery) void retryFocusedTask(true); },
    s: () => { if (inRecovery) void skipFocusedTask(); },
    q: quit,
  }, !showLog);

  useKeybinds({
    escape: () => setShowLog(false),
    l:      () => setShowLog(false),
    q:      quit,
  }, showLog);

  const termWidth = stdout?.columns ?? 120;
  const leftWidth = 36;

  const phaseLabel = ecoState.phase === 'coding_loop' ? 'Phase 2 · Coding Loop'
    : ecoState.phase === 'requirements'    ? 'Phase 1 · Requirements'
    : ecoState.phase === 'design'          ? 'Phase 1 · Design'
    : ecoState.phase === 'task_decomp'     ? 'Phase 1 · Task Decomp'
    : ecoState.phase === 'awaiting_approval' ? 'Phase 1 · Complete'
    : ecoState.phase === 'completed'       ? 'Complete'
    : ecoState.phase ?? '';

  return (
    <Box flexDirection="column" height={process.stdout.rows}>
      {/* Header */}
      <Box paddingX={1} gap={1} borderBottom borderStyle="single" borderColor={theme.border}>
        <Text color={theme.accent} bold>▲ Auto Coding Ecosystem</Text>
        {ecoState.repo && (
          <><Text color={theme.fgFaint}>·</Text><Text color={theme.fg}>{ecoState.owner}/{ecoState.repo}</Text></>
        )}
        <Text color={theme.fgFaint}>·</Text>
        <Text color={theme.review}>{phaseLabel}</Text>
        <Text color={theme.fgFaint}>{elapsed(startMs)}</Text>
        {isPaused && <Text color={theme.warning}> [一時停止中]</Text>}
      </Box>

      {/* Main */}
      <Box flexGrow={1} flexDirection="row">
        {/* Left: task list */}
        <Box width={leftWidth} flexDirection="column" borderRight borderStyle="single" borderColor={theme.border}>
          <TaskList
            tasks={tasks}
            focusedIndex={focusedIndex}
            expandedTaskId={expandedTaskId}
          />
        </Box>

        {/* Right */}
        <Box flexGrow={1} flexDirection="column">
          {showLog ? (
            <LogStream logs={ecoState.logs} visibleLines={20} />
          ) : (
            <>
              <CurrentTaskCard
                task={currentTask}
                taskIndex={ecoState.currentTaskIndex}
                totalTasks={tasks.length}
              />
              {focusedTask?.status === 'failed' && expandedTaskId === focusedTask.id ? (
                <RecoveryMenu
                  task={focusedTask}
                  onRetry={() => void retryFocusedTask(false)}
                  onRetryWithOpus={() => void retryFocusedTask(true)}
                  onSkip={() => void skipFocusedTask()}
                  onOpenPr={() => openPr(focusedTask)}
                />
              ) : (
                <LogStream logs={ecoState.logs} visibleLines={10} />
              )}
            </>
          )}
        </Box>
      </Box>

      {/* Phase 2 start prompt */}
      {ecoState.phase === 'awaiting_approval' && !phase2Started && (
        <Box paddingX={2} paddingY={0} borderTop borderStyle="single" borderColor={theme.accent}>
          <Text color={theme.accent} bold>▶ Phase 1 完了 · </Text>
          <Text color={theme.fg} bold>Enter</Text>
          <Text color={theme.fgMute}> で Phase 2 (実装) を開始 · </Text>
          <Text color={theme.fg} bold>q</Text>
          <Text color={theme.fgMute}> で終了</Text>
        </Box>
      )}

      {/* Run error */}
      {runError && (
        <Box paddingX={1} borderTop borderStyle="single" borderColor={theme.danger}>
          <Text color={theme.danger}>✗ {runError}</Text>
        </Box>
      )}

      {/* Footer */}
      <FooterHints scope={showLog ? 'log' : 'run'} />
    </Box>
  );
};
