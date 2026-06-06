import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text, useApp, useStdout, useInput, Key } from 'ink';
import Spinner from 'ink-spinner';
import { theme } from '../theme.js';
import { useEcosystemState } from '../hooks/useEcosystemState.js';
import { useKeybinds } from '../hooks/useKeybinds.js';
import { TaskList } from '../components/TaskList.js';
import { CurrentTaskCard } from '../components/CurrentTaskCard.js';
import { filterLogEvents, LogStream } from '../components/LogStream.js';
import { RecoveryMenu } from '../components/RecoveryMenu.js';
import { FooterHints } from '../components/FooterHints.js';
import { resolveRunFooterScope } from '../footer-scope.js';
import { Orchestrator } from '../../orchestrator.js';
import { StateManager } from '../../state/manager.js';
import { bus } from '../../events.js';
import { openExternalUrl } from '../../utils/open-url.js';
import type { Task } from '../../state/types.js';
import type { LogEvent } from '../../events.js';

function elapsed(startMs: number): string {
  const s = Math.floor((Date.now() - startMs) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

type LogFilterMode = 'all' | 'warn-error' | 'error' | 'github' | 'agent' | 'review';

const LOG_FILTERS: Array<{
  mode: LogFilterMode;
  label: string;
  levels?: LogEvent['level'][];
  sources?: LogEvent['source'][];
}> = [
  { mode: 'all', label: 'all' },
  { mode: 'warn-error', label: 'warn/error', levels: ['warn', 'error'] },
  { mode: 'error', label: 'error', levels: ['error'] },
  { mode: 'github', label: 'github', sources: ['github'] },
  { mode: 'agent', label: 'agent', sources: ['agent'] },
  { mode: 'review', label: 'review', sources: ['review'] },
];

function nextLogFilter(mode: LogFilterMode): LogFilterMode {
  const index = LOG_FILTERS.findIndex((filter) => filter.mode === mode);
  return LOG_FILTERS[(index + 1) % LOG_FILTERS.length].mode;
}

function getLogFilter(mode: LogFilterMode) {
  return LOG_FILTERS.find((filter) => filter.mode === mode) ?? LOG_FILTERS[0];
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
  const [previewTasks, setPreviewTasks]     = useState<Task[] | null>(null);
  const [logSearchTerm, setLogSearchTerm]   = useState('');
  const [logSearchDraft, setLogSearchDraft] = useState('');
  const [logSearchActive, setLogSearchActive] = useState(false);
  const [logFilterMode, setLogFilterMode]   = useState<LogFilterMode>('all');
  const [logScrollOffset, setLogScrollOffset] = useState(0);
  const [logFollow, setLogFollow]           = useState(true);

  // elapsed timer
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  // Issue #3: タスク分解結果の承認待ちプレビュー
  useEffect(() => {
    const onPreview = ({ tasks: previewed }: { tasks: Task[] }) => setPreviewTasks(previewed);
    bus.on('tasks:preview', onPreview);
    return () => { bus.off('tasks:preview', onPreview); };
  }, []);

  const respondToPreview = useCallback((approved: boolean) => {
    if (!previewTasks) return;
    bus.emit('tasks:approval', { approved });
    setPreviewTasks(null);
  }, [previewTasks]);

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
    if (!task?.prUrl) {
      setRunError('このタスクにはPR URLがありません。');
      return;
    }
    openExternalUrl(task.prUrl)
      .then(() => setRunError(null))
      .catch((err) => {
        setRunError(`PRをブラウザで開けませんでした: ${task.prUrl} (${String(err)})`);
      });
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
    await manager.updateTask(task.id, { status: 'skipped', errorMessage: undefined });
    launchPhase2(false);
  }, [focusedTask, orchestratorRunning, launchPhase2]);

  const inRecovery = !orchestratorRunning &&
    focusedTask?.status === 'failed' &&
    expandedTaskId === focusedTask?.id;

  // Issue #10: 「起動中 / 入力待ち」を一目で判別できるグローバル状態
  const waitingForInput =
    Boolean(previewTasks) ||
    (ecoState.phase === 'awaiting_approval' && !phase2Started) ||
    inRecovery;

  useKeybinds({
    up:     () => setFocusedIndex((i) => Math.max(0, i - 1)),
    down:   () => setFocusedIndex((i) => Math.min(tasks.length - 1, i + 1)),
    return: () => {
      if (previewTasks) {
        respondToPreview(true);
        return;
      }
      if (ecoState.phase === 'awaiting_approval' && !phase2Started) {
        startPhase2();
        return;
      }
      const id = focusedTask?.id ?? null;
      setExpandedTaskId((prev) => (prev === id ? null : id));
    },
    c: () => { if (previewTasks) respondToPreview(false); },
    l: () => setShowLog((v) => !v),
    p: () => setIsPaused((v) => !v),
    o: () => openPr(focusedTask),
    r: () => { if (inRecovery) void retryFocusedTask(false); },
    R: () => { if (inRecovery) void retryFocusedTask(true); },
    s: () => { if (inRecovery) void skipFocusedTask(); },
    q: quit,
  }, !showLog);

  const termWidth = stdout?.columns ?? 120;
  const leftWidth = 36;
  const logVisibleLines = 19;
  const logFilter = getLogFilter(logFilterMode);
  const filteredLogCount = filterLogEvents(ecoState.logs, {
    searchTerm: logSearchTerm,
    levelFilter: logFilter.levels,
    sourceFilter: logFilter.sources,
  }).length;
  const maxLogScrollOffset = Math.max(0, filteredLogCount - logVisibleLines);
  const scrollLog = useCallback((delta: number) => {
    setLogFollow(false);
    setLogScrollOffset((offset) => Math.min(maxLogScrollOffset, Math.max(0, offset + delta)));
  }, [maxLogScrollOffset]);
  const jumpLogTop = useCallback(() => {
    setLogFollow(false);
    setLogScrollOffset(maxLogScrollOffset);
  }, [maxLogScrollOffset]);
  const jumpLogBottom = useCallback(() => {
    setLogFollow(true);
    setLogScrollOffset(0);
  }, []);
  const applyLogSearch = useCallback(() => {
    setLogSearchTerm(logSearchDraft.trim());
    setLogSearchActive(false);
    setLogFollow(true);
    setLogScrollOffset(0);
  }, [logSearchDraft]);

  useInput((input: string, key: Key) => {
    if (!showLog) return;

    const keyWithBackspace = key as Key & { backspace?: boolean; delete?: boolean };
    if (logSearchActive) {
      if (key.escape) {
        setLogSearchActive(false);
        return;
      }
      if (key.return || input === '\r' || input === '\n') {
        applyLogSearch();
        return;
      }
      if (keyWithBackspace.backspace || keyWithBackspace.delete || input === '\u0008' || input === '\u007f') {
        setLogSearchDraft((draft) => draft.slice(0, -1));
        return;
      }
      if (input.length === 1 && input >= ' ') {
        setLogSearchDraft((draft) => draft + input);
      }
      return;
    }

    if (key.escape || input === 'l') {
      setShowLog(false);
      return;
    }
    if (input === 'q') {
      quit();
      return;
    }
    if (input === 'k') {
      scrollLog(1);
      return;
    }
    if (input === 'j') {
      scrollLog(-1);
      return;
    }
    if (input === 'g') {
      jumpLogTop();
      return;
    }
    if (input === 'G') {
      jumpLogBottom();
      return;
    }
    if (input === '/') {
      setLogSearchDraft(logSearchTerm);
      setLogSearchActive(true);
      return;
    }
    if (input === 'f') {
      setLogFilterMode((mode) => nextLogFilter(mode));
      setLogFollow(true);
      setLogScrollOffset(0);
      return;
    }
    if (input === 'p') {
      if (!logFollow) setLogScrollOffset(0);
      setLogFollow(!logFollow);
    }
  }, { isActive: showLog });

  const phaseLabel = ecoState.phase === 'coding_loop' ? 'Phase 2 · Coding Loop'
    : ecoState.phase === 'requirements'    ? 'Phase 1 · Requirements'
    : ecoState.phase === 'design'          ? 'Phase 1 · Design'
    : ecoState.phase === 'task_decomp'     ? 'Phase 1 · Task Decomp'
    : ecoState.phase === 'awaiting_approval' ? 'Phase 1 · Complete'
    : ecoState.phase === 'completed'       ? 'Complete'
    : ecoState.phase ?? '';
  const footerScope = resolveRunFooterScope({
    showLog,
    inRecovery,
    hasPreview: Boolean(previewTasks),
    awaitingPhase2Start: ecoState.phase === 'awaiting_approval' && !phase2Started,
  });

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
        <Text color={theme.fgFaint}>·</Text>
        {waitingForInput ? (
          <Text color={theme.warning} bold>⏸ 入力待ち</Text>
        ) : orchestratorRunning ? (
          <Text color={theme.success}><Spinner type="dots" /> 実行中</Text>
        ) : ecoState.phase === 'completed' ? (
          <Text color={theme.success}>✓ 完了</Text>
        ) : (
          <Text color={theme.fgFaint}>待機</Text>
        )}
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
            <>
              {/* Issue #11: ログ表示中も現在処理中の Issue/タスクを常時表示 */}
              <Box paddingX={1} gap={1} borderBottom borderStyle="single" borderColor={theme.border}>
                <Text color={theme.fgDim}>現在処理中</Text>
                {currentTask ? (
                  <>
                    <Text color={theme.fg} bold>Task {ecoState.currentTaskIndex + 1}/{tasks.length}</Text>
                    {currentTask.issueNumber && (
                      <>
                        <Text color={theme.fgFaint}>·</Text>
                        <Text color={theme.info}>Issue #{currentTask.issueNumber}</Text>
                      </>
                    )}
                    <Text color={theme.fgFaint}>·</Text>
                    <Text color={theme.fg}>{currentTask.title}</Text>
                  </>
                ) : (
                  <Text color={theme.fgFaint}>待機中...</Text>
                )}
              </Box>
              <LogStream
                logs={ecoState.logs}
                visibleLines={logVisibleLines}
                searchTerm={logSearchTerm}
                levelFilter={logFilter.levels}
                sourceFilter={logFilter.sources}
                scrollOffset={logScrollOffset}
                follow={logFollow}
                statusItems={[
                  logSearchActive ? `search: ${logSearchDraft || '(typing)'}` : logSearchTerm ? `search: ${logSearchTerm}` : '',
                  `filter: ${logFilter.label}`,
                  logFollow ? 'follow' : `paused +${logScrollOffset}`,
                ].filter(Boolean)}
              />
            </>
          ) : (
            <>
              <CurrentTaskCard
                task={currentTask}
                taskIndex={ecoState.currentTaskIndex}
                totalTasks={tasks.length}
                hideError={inRecovery && focusedTask?.id === currentTask?.id}
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

      {/* Issue #3: タスク承認プレビュー */}
      {previewTasks && (
        <Box flexDirection="column" paddingX={2} paddingY={0} borderTop borderStyle="single" borderColor={theme.accent}>
          <Text color={theme.accent} bold>▶ タスク分解結果（{previewTasks.length}件）· Issue 起票前の確認</Text>
          {previewTasks.slice(0, 12).map((t, i) => (
            <Text key={t.id} color={theme.fg}>
              {`${i + 1}. `}{t.title}
              {t.complexity ? <Text color={theme.fgFaint}> [{t.complexity}]</Text> : null}
            </Text>
          ))}
          {previewTasks.length > 12 && (
            <Text color={theme.fgFaint}>... 他 {previewTasks.length - 12} 件</Text>
          )}
          <Box marginTop={0}>
            <Text color={theme.fg} bold>Enter</Text>
            <Text color={theme.fgMute}> で承認して Issue 起票 · </Text>
            <Text color={theme.fg} bold>c</Text>
            <Text color={theme.fgMute}> で中止</Text>
          </Box>
        </Box>
      )}

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
      <FooterHints scope={footerScope} />
    </Box>
  );
};
