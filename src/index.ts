#!/usr/bin/env node
// .env はほかのモジュールより先に読み込む（必ず最初の import にする。理由は env.ts を参照）
import './env.js';
import React from 'react';
import { render } from 'ink';
import { StateManager } from './state/manager.js';
import { Orchestrator } from './orchestrator.js';
import { logger, isPlainMode } from './utils/logger.js';
import { isLlmUsageLimitError, LlmUsageLimitError } from './utils/llm-errors.js';
import { App } from './ui/App.js';
import { showHomeMenu } from './ui/prompts/homeMenu.js';
import { showRequestWizard, showModelSelectWizard, showLoopSelectWizard } from './ui/prompts/requestWizard.js';
import { ensureGhAuth } from './ui/prompts/authPrompt.js';
import { parseCodexIntelligence } from './utils/codex-options.js';
import { buildIssuesInstruction } from './utils/issue-instruction.js';
import { readInstructionFile } from './utils/instruction-file.js';
import { GitHubAgent } from './agents/github-agent.js';
import { bus } from './events.js';
import type { SourceIssue, Task } from './state/types.js';
import { t } from './utils/i18n.js';

// ── helpers ──────────────────────────────────────────────────────────────────

type LimitProvider = 'claude' | 'codex' | 'gemini' | 'all';
type LlmProviderOption = Exclude<LimitProvider, 'all'>;

function parseLlmProviderOption(value: string): LlmProviderOption {
  if (value === 'claude' || value === 'codex' || value === 'gemini') return value;
  throw new Error('provider must be one of: claude, codex, gemini');
}

function parseIssueNumber(value: string): number {
  const issueNumber = Number(value);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error('--issue-number must be a positive integer');
  }
  return issueNumber;
}

function parseIssueNumbers(value: string): number[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map(parseIssueNumber);
}

function applyLlmOptions(args: string[]): void {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--claude-model' && i + 1 < args.length) {
      process.env.PLANNING_CLAUDE_MODEL = args[i + 1];
      process.env.IMPLEMENTATION_CLAUDE_MODEL = args[i + 1];
      i++;
    } else if (args[i] === '--planning-model' && i + 1 < args.length) {
      process.env.PLANNING_CLAUDE_MODEL = args[i + 1];
      i++;
    } else if (args[i] === '--impl-model' && i + 1 < args.length) {
      process.env.IMPLEMENTATION_CLAUDE_MODEL = args[i + 1];
      i++;
    } else if (args[i] === '--codex-model' && i + 1 < args.length) {
      process.env.CODEX_MODEL = args[i + 1];
      i++;
    } else if (args[i] === '--gemini-model' && i + 1 < args.length) {
      process.env.PLANNING_GEMINI_MODEL = args[i + 1];
      process.env.IMPLEMENTATION_GEMINI_MODEL = args[i + 1];
      i++;
    } else if (
      (args[i] === '--codex-intelligence' || args[i] === '--codex-reasoning-effort') &&
      i + 1 < args.length
    ) {
      process.env.CODEX_INTELLIGENCE = parseCodexIntelligence(args[i + 1]);
      i++;
    } else if (
      (args[i] === '--provider' || args[i] === '--primary-provider') &&
      i + 1 < args.length
    ) {
      const provider = parseLlmProviderOption(args[i + 1]);
      process.env.PLANNING_LLM_PROVIDER = provider;
      process.env.IMPLEMENTATION_LLM_PROVIDER = provider;
      i++;
    } else if (args[i] === '--fallback-provider' && i + 1 < args.length) {
      process.env.FALLBACK_LLM_PROVIDER = parseLlmProviderOption(args[i + 1]);
      i++;
    }
  }
}

function applyWizardCodexOptions(
  wizard: Awaited<ReturnType<typeof showRequestWizard>>
): void {
  if (wizard.codexModel !== undefined) {
    if (wizard.codexModel) {
      process.env.CODEX_MODEL = wizard.codexModel;
    } else {
      delete process.env.CODEX_MODEL;
    }
  }

  if (wizard.codexIntelligence !== undefined) {
    if (wizard.codexIntelligence === 'config') {
      delete process.env.CODEX_INTELLIGENCE;
      delete process.env.CODEX_MODEL_REASONING_EFFORT;
    } else {
      process.env.CODEX_INTELLIGENCE = wizard.codexIntelligence;
    }
  }
}

function parseLimitProvider(args: string[]): LimitProvider {
  const idx = args.indexOf('--limit-provider');
  if (idx === -1) return 'all';
  const v = args[idx + 1];
  if (v === 'claude' || v === 'codex' || v === 'gemini' || v === 'all') return v;
  throw new Error('--limit-provider must be one of: claude, codex, gemini, all');
}

function configureAiTokenMode(provider: LimitProvider): void {
  process.env.AI_TOKEN_MODE = provider;
  if (provider === 'claude') {
    process.env.PLANNING_LLM_PROVIDER = 'claude';
    process.env.IMPLEMENTATION_LLM_PROVIDER = 'claude';
  } else if (provider === 'codex') {
    process.env.PLANNING_LLM_PROVIDER = 'codex';
    process.env.IMPLEMENTATION_LLM_PROVIDER = 'codex';
  } else if (provider === 'gemini') {
    process.env.PLANNING_LLM_PROVIDER = 'gemini';
    process.env.IMPLEMENTATION_LLM_PROVIDER = 'gemini';
  } else {
    process.env.PLANNING_LLM_PROVIDER = 'claude';
    process.env.IMPLEMENTATION_LLM_PROVIDER = 'claude';
  }
}

function truncate(v: string, n: number): string {
  return v.length <= n ? v : v.slice(0, n - 3) + '...';
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${s}s`;
}

// ── Issue #3: タスク承認 ───────────────────────────────────────────────────────

/** タスク承認が有効か（既定: 有効。TASK_APPROVAL=false で無効化）。 */
function taskApprovalEnabled(): boolean {
  return process.env.TASK_APPROVAL !== 'false';
}

function printTaskPreview(tasks: Task[]): void {
  console.log(t(`\nタスク分解結果（${tasks.length}件）— GitHub Issue 起票前の確認:`, `\nTask breakdown (${tasks.length}) — review before creating GitHub Issues:`));
  tasks.forEach((t, i) => {
    const cx = t.complexity ? ` [${t.complexity}]` : '';
    console.log(`  ${i + 1}. ${cleanOneLine(t.title)}${cx}`);
  });
}

/** plain モード: 標準入力から y/N でタスク起票を確認する。 */
function confirmTasksViaStdin(tasks: Task[]): Promise<boolean> {
  printTaskPreview(tasks);
  return new Promise((resolve) => {
    process.stdout.write(t('\nこの内容で GitHub Issue を起票しますか？ [y/N]: ', '\nCreate GitHub Issues with this content? [y/N]: '));
    process.stdin.resume();
    process.stdin.once('data', (d: Buffer) => {
      const ans = d.toString().trim().toLowerCase();
      process.stdin.pause();
      resolve(ans === 'y' || ans === 'yes');
    });
  });
}

/** Ink モード: イベントバス経由で RunScreen に承認を委ねる。 */
function confirmTasksViaInk(tasks: Task[]): Promise<boolean> {
  return new Promise((resolve) => {
    bus.once('tasks:approval', (data: { approved: boolean }) => resolve(data.approved));
    bus.emit('tasks:preview', { tasks });
  });
}

function cleanOneLine(v: string): string {
  return v.replace(/\s+/g, ' ').trim();
}

function formatLatestCheckDetail(task: Task): string | null {
  const visible = (task.lastChecks ?? []).filter((check) => check.status !== 'passed');
  const latest = visible.length > 0 ? visible[visible.length - 1] : null;
  if (!latest) return null;
  return truncate(cleanOneLine(`${latest.name}:${latest.status} ${latest.summary}`), 60);
}

function printFinalState(state: NonNullable<Awaited<ReturnType<StateManager['load']>>>): void {
  const total = state.tasks.length;
  const failed = state.tasks.filter((t) => t.status === 'failed').length;
  const merged = state.tasks.filter((t) => t.status === 'merged').length;
  const pending = state.tasks.filter((t) => t.status === 'pending').length;
  const skipped = state.tasks.filter((t) => t.status === 'skipped').length;
  const inProgress = total - merged - failed - pending - skipped;

  // Project header
  console.log('');
  console.log(`Project   : ${state.githubOwner}/${state.githubRepo}`);
  console.log(`Repo      : https://github.com/${state.githubOwner}/${state.githubRepo}`);
  console.log(`Phase     : ${state.phase}`);
  console.log(`Instruction: ${truncate(cleanOneLine(state.userInstruction), 80)}`);

  // Progress bar + counts (Issue #5)
  const barWidth = 24;
  const filled = total > 0 ? Math.round((merged / total) * barWidth) : 0;
  const bar = '█'.repeat(filled) + '░'.repeat(Math.max(0, barWidth - filled));
  const pct = total > 0 ? Math.round((merged / total) * 100) : 0;
  console.log(`Progress  : [${bar}] ${pct}%  (${merged}/${total})`);
  console.log(
    `Summary   : merged ${merged}  in-progress ${inProgress}  pending ${pending}  skipped ${skipped}  failed ${failed}`
  );
  console.log('');

  // Column headers
  const COL = { n: 3, title: 36, status: 12, issue: 7, pr: 6, age: 7 };
  const header =
    '#'.padEnd(COL.n) + ' ' +
    'TASK'.padEnd(COL.title) + ' ' +
    'STATUS'.padEnd(COL.status) + ' ' +
    'ISSUE'.padEnd(COL.issue) + ' ' +
    'PR'.padEnd(COL.pr) + ' ' +
    'AGE'.padEnd(COL.age) + ' ' +
    'DETAIL';
  console.log(header);
  console.log('-'.repeat(header.length + 10));

  state.tasks.forEach((task, i) => {
    const issue = task.issueNumber ? `#${task.issueNumber}` : '-';
    const pr    = task.prNumber    ? `#${task.prNumber}`    : '-';
    const age = formatDuration(
      new Date(task.updatedAt).getTime() - new Date(task.createdAt).getTime()
    );
    const detail = formatLatestCheckDetail(task)
      ?? (task.status === 'failed' && task.errorMessage
        ? truncate(cleanOneLine(task.errorMessage), 60)
        : task.reviewIteration > 0 ? `iter ${task.reviewIteration}` : '-');
    console.log(
      (i + 1).toString().padEnd(COL.n) + ' ' +
      truncate(task.title, COL.title).padEnd(COL.title) + ' ' +
      task.status.padEnd(COL.status) + ' ' +
      issue.padEnd(COL.issue) + ' ' +
      pr.padEnd(COL.pr) + ' ' +
      age.padEnd(COL.age) + ' ' +
      detail
    );
  });

  // Clickable links (Issue #5)
  const linked = state.tasks.filter((t) => t.issueUrl || t.prUrl);
  if (linked.length > 0) {
    console.log('');
    console.log('Links:');
    linked.forEach((task) => {
      const idx = state.tasks.indexOf(task) + 1;
      const parts = [
        task.issueUrl ? `issue ${task.issueUrl}` : '',
        task.prUrl ? `pr ${task.prUrl}` : '',
      ].filter(Boolean).join('  ');
      console.log(`  ${idx}. ${truncate(cleanOneLine(task.title), 36)}  ${parts}`);
    });
  }
}

async function printLlmLimitNotice(err: LlmUsageLimitError): Promise<void> {
  console.error(t(`\n${err.provider} の利用上限に達したため停止しました。`, `\nStopped: ${err.provider} usage limit reached.`));
  console.error(t('再開: npm run dev -- phase2 --retry-failed\n', 'Resume: npm run dev -- phase2 --retry-failed\n'));
  const state = await new StateManager().load().catch(() => null);
  if (state) printFinalState(state);
}

async function loadIssuesInstruction(
  owner: string,
  repoName: string,
  issueNumbers: number[],
  supplementalInstruction?: string | null
): Promise<{ instruction: string; sourceIssues: SourceIssue[] }> {
  const uniqueIssueNumbers = [...new Set(issueNumbers)];
  const githubAgent = new GitHubAgent();
  const sourceIssues = await Promise.all(
    uniqueIssueNumbers.map((issueNumber) => githubAgent.getIssue(owner, repoName, issueNumber))
  );
  const issueInstruction = buildIssuesInstruction(sourceIssues);
  const supplemental = supplementalInstruction?.trim();

  return {
    sourceIssues,
    instruction: supplemental
      ? [issueInstruction, '', t('追加指示:', 'Additional instructions:'), supplemental].join('\n')
      : issueInstruction,
  };
}

// ── ink launcher ─────────────────────────────────────────────────────────────

async function launchInk(runFn: () => Promise<void>): Promise<void> {
  const { waitUntilExit } = render(
    React.createElement(App, { runFn })
  );
  await waitUntilExit();
}

// ── plain-mode commands (CI / --plain) ───────────────────────────────────────

async function plainStart(
  instruction: string,
  repoName: string,
  autoPhase2: boolean,
  retryFailed: boolean,
  options: {
    projectMode?: 'new' | 'modify';
    ownerOverride?: string;
    sourceIssue?: SourceIssue;
    sourceIssues?: SourceIssue[];
  } = {}
): Promise<void> {
  const owner = options.ownerOverride || process.env.GITHUB_OWNER;
  if (!owner) { console.error('Error: GITHUB_OWNER not set'); process.exit(1); }

  // Issue #3: --auto でなく TTY のときのみ起票前にタスク承認を求める
  const confirmTasks =
    !autoPhase2 && taskApprovalEnabled() && process.stdin.isTTY
      ? confirmTasksViaStdin
      : undefined;

  const orchestrator = new Orchestrator();
  const state = await orchestrator.runPhase1(instruction, owner, repoName, {
    projectMode: options.projectMode || 'new',
    sourceIssue: options.sourceIssue,
    sourceIssues: options.sourceIssues,
    confirmTasks,
  });

  if (state.phase === 'aborted') {
    console.log(t('\nタスクが承認されなかったため、Issue を起票せずに中止しました。', '\nAborted — task list was not approved; no Issues were created.'));
    return;
  }

  console.log(`\nTasks created: ${state.tasks.length}`);
  state.tasks.forEach((t, i) => {
    console.log(`${i + 1}. ${t.title} [${t.status}]`);
  });

  if (autoPhase2) {
    await orchestrator.runPhase2(retryFailed);
    const finalState = await new StateManager().load();
    if (finalState) printFinalState(finalState);
  }
}

async function plainPhase2(
  retryFailed: boolean,
  options: { loopUntilLimit?: boolean; limitProvider?: LimitProvider } = {}
): Promise<void> {
  const stateManager = new StateManager();
  const state = await stateManager.load();
  if (!state?.tasks?.length) {
    console.error('No project state found.'); process.exit(1);
  }

  configureAiTokenMode(options.limitProvider || 'all');

  if (options.loopUntilLimit) {
    await runPhase2RetryLoop(options.limitProvider || 'all');
  } else {
    const orchestrator = new Orchestrator();
    await orchestrator.runPhase2(retryFailed);
    const finalState = await stateManager.load();
    if (finalState) printFinalState(finalState);
  }
}

async function runPhase2RetryLoop(limitProvider: LimitProvider, maxAttempts?: number): Promise<void> {
  const resolvedMax = maxAttempts ?? Number(process.env.PHASE2_LOOP_MAX_ATTEMPTS || '100');
  let stoppedWithNoFailures = false;

  for (let attempt = 1; attempt <= resolvedMax; attempt++) {
    logger.section(`PHASE 2 RETRY LOOP ${attempt}/${resolvedMax}`);
    configureAiTokenMode(limitProvider);

    const orch = new Orchestrator();
    await orch.runPhase2(true);

    const latest = await new StateManager().load();
    if (!latest) continue;

    printFinalState(latest);

    const remainingCount = latest.tasks.filter((t) => t.status !== 'merged' && t.status !== 'skipped').length;
    const skippedCount = latest.tasks.filter((t) => t.status === 'skipped').length;
    if (remainingCount === 0) {
      if (skippedCount > 0) {
        logger.warn(
          'Stopping Phase 2 retry loop because only skipped tasks remain',
          `${skippedCount}/${latest.tasks.length} tasks skipped`
        );
      } else {
        logger.info('Stopping Phase 2 retry loop because all tasks are merged');
      }
      stoppedWithNoFailures = true;
      break;
    }

    logger.info(
      'Continuing Phase 2 retry loop because actionable tasks remain',
      `${remainingCount}/${latest.tasks.length} tasks are not merged or skipped`
    );
  }

  if (!stoppedWithNoFailures) {
    logger.warn(
      'Phase 2 retry loop stopped by max attempts',
      `PHASE2_LOOP_MAX_ATTEMPTS=${resolvedMax}`
    );
  }
}

// ── UI-mode entry ─────────────────────────────────────────────────────────────

async function uiEntry(args: string[]): Promise<void> {
  // Legacy commands still work in UI mode but skip the home menu
  if (args[0] === 'start' || args[0] === 'modify') {
    let instruction: string | null = null;
    let instructionFile: string | null = null;
    let repoName: string | null = null;
    let ownerOverride: string | undefined;
    let autoPhase2 = false;
    let retryFailed = false;
    const issueNumbers: number[] = [];

    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--instruction'      && i + 1 < args.length) { instruction     = args[++i]; }
      else if (args[i] === '--instruction-file' && i + 1 < args.length) { instructionFile = args[++i]; }
      else if (args[i] === '--repo-name'   && i + 1 < args.length) { repoName        = args[++i]; }
      else if (args[i] === '--target-repo' && i + 1 < args.length) {
        const parts = args[++i].split('/');
        if (parts.length === 2) { ownerOverride = parts[0]; repoName = parts[1]; }
        else { repoName = args[i]; }
      }
      else if (args[i] === '--auto')         { autoPhase2 = true; }
      else if (args[i] === '--retry-failed') { retryFailed = true; }
      else if (args[i] === '--issue-number' && i + 1 < args.length) { issueNumbers.push(...parseIssueNumbers(args[++i])); }
    }

    if (instructionFile) instruction = await readInstructionFile(instructionFile);
    if (!repoName || (!instruction && issueNumbers.length === 0)) {
      console.error('Error: instruction or issue-number, and repo-name are required'); process.exit(1);
    }

    const owner = ownerOverride || process.env.GITHUB_OWNER;
    if (!owner) { console.error('Error: GITHUB_OWNER not set'); process.exit(1); }

    let sourceIssues: SourceIssue[] | undefined;
    if (issueNumbers.length > 0) {
      await ensureGhAuth();
      const issueInput = await loadIssuesInstruction(owner, repoName, issueNumbers, instruction);
      instruction = issueInput.instruction;
      sourceIssues = issueInput.sourceIssues;
    }

    const projectMode = args[0] === 'modify' ? 'modify' : 'new';
    const orchestrator = new Orchestrator();

    await ensureGhAuth();
    await launchInk(async () => {
      await orchestrator.runPhase1(instruction!, owner, repoName!, {
        projectMode,
        sourceIssue: sourceIssues?.[0],
        sourceIssues,
      });
      if (autoPhase2) await orchestrator.runPhase2(retryFailed);
    });
    return;
  }

  if (args[0] === 'phase2') {
    const retryFailed   = args.includes('--retry-failed');
    const loopUntilLimit = args.includes('--loop-until-limit');
    const limitProvider  = parseLimitProvider(args);
    configureAiTokenMode(limitProvider);

    const orchestrator = new Orchestrator();
    await ensureGhAuth();
    await launchInk(async () => {
      if (loopUntilLimit) {
        await runPhase2RetryLoop(limitProvider);
      } else {
        await orchestrator.runPhase2(retryFailed);
      }
    });
    return;
  }

  if (args[0] === 'status') {
    const stateManager = new StateManager();
    const state = await stateManager.load();
    if (!state) { console.log('No project state found.'); return; }
    printFinalState(state);
    return;
  }

  // No args → interactive home menu
  const choice = await showHomeMenu();

  if (choice === 'quit') {
    process.exit(0);
  }

  if (choice === 'status') {
    const stateManager = new StateManager();
    const state = await stateManager.load();
    if (!state) { console.log('No project state found.'); return; }
    printFinalState(state);
    return;
  }

  if (choice === 'resume') {
    const stateManager = new StateManager();
    const state = await stateManager.load();
    if (!state) { console.error('No state to resume.'); process.exit(1); }

    const modelSelection = await showModelSelectWizard();
    process.env.PLANNING_CLAUDE_MODEL = modelSelection.planningModel;
    process.env.IMPLEMENTATION_CLAUDE_MODEL = modelSelection.implModel;

    const executionCount = await showLoopSelectWizard();

    await ensureGhAuth();
    const orchestrator = new Orchestrator();
    await launchInk(async () => {
      if (executionCount === 0 || executionCount > 1) {
        const maxAttempts = executionCount === 0
          ? Number(process.env.PHASE2_LOOP_MAX_ATTEMPTS || '100')
          : executionCount;
        await runPhase2RetryLoop('all', maxAttempts);
      } else {
        await orchestrator.runPhase2(true);
      }
    });
    return;
  }

  // new / issue / phase1only
  await ensureGhAuth();
  const wizard = await showRequestWizard(
    choice === 'issue' ? { projectMode: 'modify' } : {},
    {
      forceProjectMode: choice === 'issue' ? 'modify' : undefined,
      defaultPhaseMode: choice === 'phase1only' ? 'phase1only' : undefined,
    }
  );
  process.env.PLANNING_CLAUDE_MODEL = wizard.planningModel;
  process.env.IMPLEMENTATION_CLAUDE_MODEL = wizard.implModel;
  process.env.TASK_MODEL_ROUTING = wizard.taskModelRouting ? 'true' : 'false';
  process.env.PLANNING_LLM_PROVIDER = wizard.primaryProvider;
  process.env.IMPLEMENTATION_LLM_PROVIDER = wizard.primaryProvider;
  process.env.FALLBACK_LLM_PROVIDER = wizard.fallbackProvider;
  applyWizardCodexOptions(wizard);
  if (wizard.geminiModel) {
    process.env.GEMINI_MODEL = wizard.geminiModel;
  }

  const orchestrator = new Orchestrator();

  await launchInk(async () => {
    const phase1State = await orchestrator.runPhase1(wizard.instruction, wizard.owner, wizard.repoName, {
      projectMode: wizard.projectMode,
      sourceIssue: wizard.sourceIssue,
      sourceIssues: wizard.sourceIssues,
      confirmTasks: taskApprovalEnabled() ? confirmTasksViaInk : undefined,
    });
    if (phase1State.phase === 'aborted') return;
    if (wizard.phaseMode === 'phase1+2') {
      const count = wizard.executionCount;
      if (count === 0 || count > 1) {
        const maxAttempts = count === 0
          ? Number(process.env.PHASE2_LOOP_MAX_ATTEMPTS || '100')
          : count;
        await runPhase2RetryLoop('all', maxAttempts);
      } else {
        await orchestrator.runPhase2(false);
      }
    }
  });
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  // strip standalone flags so args[0] is always the command (or absent)
  const args = rawArgs.filter((a) => a !== '--plain');
  applyLlmOptions(args);

  const plain = isPlainMode();

  try {
    if (plain) {
      // Plain mode: original CLI behaviour
      if (!args[0]) {
        console.log('Usage: npm run dev -- <command> [options]');
        console.log('Commands: start, modify, phase2, status');
        console.log('Add --plain for non-TTY / CI usage.');
        process.exit(1);
      }

      if (args[0] === 'start' || args[0] === 'modify') {
        let instruction: string | null = null;
        let instructionFile: string | null = null;
        let repoName: string | null = null;
        let ownerOverride: string | undefined;
        let autoPhase2 = false;
        let retryFailed = false;
        const issueNumbers: number[] = [];

        for (let i = 1; i < args.length; i++) {
          if (args[i] === '--instruction'       && i + 1 < args.length) { instruction     = args[++i]; }
          else if (args[i] === '--instruction-file'  && i + 1 < args.length) { instructionFile = args[++i]; }
          else if (args[i] === '--repo-name'    && i + 1 < args.length) { repoName        = args[++i]; }
          else if (args[i] === '--target-repo'  && i + 1 < args.length) {
            const parts = args[++i].split('/');
            if (parts.length === 2) { ownerOverride = parts[0]; repoName = parts[1]; }
            else { repoName = args[i]; }
          }
          else if (args[i] === '--auto')          { autoPhase2 = true; }
          else if (args[i] === '--retry-failed')  { retryFailed = true; }
          else if (args[i] === '--issue-number' && i + 1 < args.length) { issueNumbers.push(...parseIssueNumbers(args[++i])); }
        }
        if (instructionFile) instruction = await readInstructionFile(instructionFile);
        if (!repoName || (!instruction && issueNumbers.length === 0)) { console.error('instruction or issue-number, and repo-name are required'); process.exit(1); }
        let sourceIssues: SourceIssue[] | undefined;
        if (issueNumbers.length > 0) {
          const owner = ownerOverride || process.env.GITHUB_OWNER;
          if (!owner) { console.error('GITHUB_OWNER is required for issue-number'); process.exit(1); }
          const issueInput = await loadIssuesInstruction(owner, repoName, issueNumbers, instruction);
          instruction = issueInput.instruction;
          sourceIssues = issueInput.sourceIssues;
        }
        await plainStart(instruction!, repoName, autoPhase2, retryFailed, {
          projectMode: args[0] === 'modify' ? 'modify' : 'new',
          ownerOverride,
          sourceIssue: sourceIssues?.[0],
          sourceIssues,
        });
      } else if (args[0] === 'phase2') {
        await plainPhase2(args.includes('--retry-failed') || args.includes('--loop-until-limit'), {
          loopUntilLimit: args.includes('--loop-until-limit'),
          limitProvider: parseLimitProvider(args),
        });
      } else if (args[0] === 'status') {
        const state = await new StateManager().load();
        if (!state) { console.log('No project state found.'); }
        else { printFinalState(state); }
      } else {
        console.error(`Unknown command: ${args[0]}`); process.exit(1);
      }
    } else {
      await uiEntry(args);
    }
  } catch (err) {
    if (isLlmUsageLimitError(err)) {
      await printLlmLimitNotice(err);
      process.exit(2);
    }
    logger.error('Fatal error', err);
    process.exit(1);
  }
}

main();
