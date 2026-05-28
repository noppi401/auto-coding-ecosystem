import { config } from 'dotenv';
import { promises as fs } from 'fs';
import { resolve } from 'path';
import React from 'react';
import { render } from 'ink';
import { StateManager } from './state/manager.js';
import { Orchestrator } from './orchestrator.js';
import { logger, isPlainMode } from './utils/logger.js';
import { isLlmUsageLimitError, LlmUsageLimitError } from './utils/llm-errors.js';
import { App } from './ui/App.js';
import { showHomeMenu } from './ui/prompts/homeMenu.js';
import { showRequestWizard, showModelSelectWizard } from './ui/prompts/requestWizard.js';
import { ensureGhAuth } from './ui/prompts/authPrompt.js';
import { parseCodexIntelligence } from './utils/codex-options.js';
import { buildIssueInstruction } from './utils/issue-instruction.js';
import { GitHubAgent } from './agents/github-agent.js';
import type { SourceIssue } from './state/types.js';

config({ path: resolve('.env') });

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

function cleanOneLine(v: string): string {
  return v.replace(/\s+/g, ' ').trim();
}

function printFinalState(state: NonNullable<Awaited<ReturnType<StateManager['load']>>>): void {
  const failed = state.tasks.filter((t) => t.status === 'failed').length;
  const merged = state.tasks.filter((t) => t.status === 'merged').length;

  // Project header
  console.log('');
  console.log(`Project   : ${state.githubOwner}/${state.githubRepo}`);
  console.log(`Repo      : https://github.com/${state.githubOwner}/${state.githubRepo}`);
  console.log(`Phase     : ${state.phase}`);
  console.log(`Instruction: ${truncate(cleanOneLine(state.userInstruction), 80)}`);
  console.log(`Summary   : Merged ${merged}/${state.tasks.length}  Failed ${failed}/${state.tasks.length}`);
  console.log('');

  // Column headers
  const COL = { n: 3, title: 40, status: 12, issue: 7, pr: 6 };
  const header =
    '#'.padEnd(COL.n) + ' ' +
    'TASK'.padEnd(COL.title) + ' ' +
    'STATUS'.padEnd(COL.status) + ' ' +
    'ISSUE'.padEnd(COL.issue) + ' ' +
    'PR'.padEnd(COL.pr) + ' ' +
    'DETAIL';
  console.log(header);
  console.log('-'.repeat(header.length + 10));

  state.tasks.forEach((task, i) => {
    const issue = task.issueNumber ? `#${task.issueNumber}` : '-';
    const pr    = task.prNumber    ? `#${task.prNumber}`    : '-';
    const detail = task.status === 'failed' && task.errorMessage
      ? truncate(cleanOneLine(task.errorMessage), 60)
      : task.reviewIteration > 0 ? `iter ${task.reviewIteration}` : '-';
    console.log(
      (i + 1).toString().padEnd(COL.n) + ' ' +
      task.title.padEnd(COL.title) + ' ' +
      task.status.padEnd(COL.status) + ' ' +
      issue.padEnd(COL.issue) + ' ' +
      pr.padEnd(COL.pr) + ' ' +
      detail
    );
  });
}

async function printLlmLimitNotice(err: LlmUsageLimitError): Promise<void> {
  console.error(`\n${err.provider} の利用上限に達したため停止しました。`);
  console.error('再開: npm run dev -- phase2 --retry-failed\n');
  const state = await new StateManager().load().catch(() => null);
  if (state) printFinalState(state);
}

async function loadIssueInstruction(
  owner: string,
  repoName: string,
  issueNumber: number,
  supplementalInstruction?: string | null
): Promise<{ instruction: string; sourceIssue: SourceIssue }> {
  const sourceIssue = await new GitHubAgent().getIssue(owner, repoName, issueNumber);
  const issueInstruction = buildIssueInstruction(sourceIssue);
  const supplemental = supplementalInstruction?.trim();

  return {
    sourceIssue,
    instruction: supplemental
      ? [issueInstruction, '', '追加指示:', supplemental].join('\n')
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
  options: { projectMode?: 'new' | 'modify'; ownerOverride?: string; sourceIssue?: SourceIssue } = {}
): Promise<void> {
  const owner = options.ownerOverride || process.env.GITHUB_OWNER;
  if (!owner) { console.error('Error: GITHUB_OWNER not set'); process.exit(1); }

  const orchestrator = new Orchestrator();
  const state = await orchestrator.runPhase1(instruction, owner, repoName, {
    projectMode: options.projectMode || 'new',
    sourceIssue: options.sourceIssue,
  });

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

async function runPhase2RetryLoop(limitProvider: LimitProvider): Promise<void> {
  const maxAttempts = Number(process.env.PHASE2_LOOP_MAX_ATTEMPTS || '100');
  let stoppedWithNoFailures = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    logger.section(`PHASE 2 RETRY LOOP ${attempt}/${maxAttempts}`);
    configureAiTokenMode(limitProvider);

    const orch = new Orchestrator();
    await orch.runPhase2(true);

    const latest = await new StateManager().load();
    if (!latest) continue;

    printFinalState(latest);

    const remainingCount = latest.tasks.filter((t) => t.status !== 'merged').length;
    if (remainingCount === 0) {
      logger.info('Stopping Phase 2 retry loop because all tasks are merged');
      stoppedWithNoFailures = true;
      break;
    }

    logger.info(
      'Continuing Phase 2 retry loop because tasks remain',
      `${remainingCount}/${latest.tasks.length} tasks are not merged`
    );
  }

  if (!stoppedWithNoFailures) {
    logger.warn(
      'Phase 2 retry loop stopped by max attempts',
      `PHASE2_LOOP_MAX_ATTEMPTS=${maxAttempts}`
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
    let issueNumber: number | undefined;

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
      else if (args[i] === '--issue-number' && i + 1 < args.length) { issueNumber = parseIssueNumber(args[++i]); }
    }

    if (instructionFile) instruction = await fs.readFile(instructionFile, 'utf-8');
    if (!repoName || (!instruction && !issueNumber)) {
      console.error('Error: instruction or issue-number, and repo-name are required'); process.exit(1);
    }

    const owner = ownerOverride || process.env.GITHUB_OWNER;
    if (!owner) { console.error('Error: GITHUB_OWNER not set'); process.exit(1); }

    let sourceIssue: SourceIssue | undefined;
    if (issueNumber) {
      await ensureGhAuth();
      const issueInput = await loadIssueInstruction(owner, repoName, issueNumber, instruction);
      instruction = issueInput.instruction;
      sourceIssue = issueInput.sourceIssue;
    }

    const projectMode = args[0] === 'modify' ? 'modify' : 'new';
    const orchestrator = new Orchestrator();

    await ensureGhAuth();
    await launchInk(async () => {
      await orchestrator.runPhase1(instruction!, owner, repoName!, { projectMode, sourceIssue });
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

    await ensureGhAuth();
    const orchestrator = new Orchestrator();
    await launchInk(async () => {
      await orchestrator.runPhase2(true);
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
  process.env.PLANNING_LLM_PROVIDER = wizard.primaryProvider;
  process.env.IMPLEMENTATION_LLM_PROVIDER = wizard.primaryProvider;
  process.env.FALLBACK_LLM_PROVIDER = wizard.fallbackProvider;
  applyWizardCodexOptions(wizard);

  const orchestrator = new Orchestrator();

  await launchInk(async () => {
    await orchestrator.runPhase1(wizard.instruction, wizard.owner, wizard.repoName, {
      projectMode: wizard.projectMode,
      sourceIssue: wizard.sourceIssue,
    });
    if (wizard.phaseMode === 'phase1+2') {
      await orchestrator.runPhase2(false);
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
        let issueNumber: number | undefined;

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
          else if (args[i] === '--issue-number' && i + 1 < args.length) { issueNumber = parseIssueNumber(args[++i]); }
        }
        if (instructionFile) instruction = await fs.readFile(instructionFile, 'utf-8');
        if (!repoName || (!instruction && !issueNumber)) { console.error('instruction or issue-number, and repo-name are required'); process.exit(1); }
        let sourceIssue: SourceIssue | undefined;
        if (issueNumber) {
          const owner = ownerOverride || process.env.GITHUB_OWNER;
          if (!owner) { console.error('GITHUB_OWNER is required for issue-number'); process.exit(1); }
          const issueInput = await loadIssueInstruction(owner, repoName, issueNumber, instruction);
          instruction = issueInput.instruction;
          sourceIssue = issueInput.sourceIssue;
        }
        await plainStart(instruction!, repoName, autoPhase2, retryFailed, {
          projectMode: args[0] === 'modify' ? 'modify' : 'new',
          ownerOverride,
          sourceIssue,
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
