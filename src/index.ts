import { config } from 'dotenv';
import { promises as fs } from 'fs';
import { resolve } from 'path';
import { StateManager } from './state/manager.js';
import { Orchestrator } from './orchestrator.js';
import { logger } from './utils/logger.js';
import {
  LlmUsageLimitError,
  isLlmUsageLimitError,
} from './utils/llm-errors.js';

// Load environment variables
config({ path: resolve('.env') });

async function cmdStart(
  instruction: string,
  repoName: string,
  autoPhase2: boolean = false,
  retryFailed: boolean = false,
  options: {
    projectMode?: 'new' | 'modify';
    ownerOverride?: string;
  } = {}
) {
  logger.section('AUTO CODING ECOSYSTEM - START');

  const owner = options.ownerOverride || process.env.GITHUB_OWNER;
  if (!owner) {
    console.error(
      'Error: GITHUB_OWNER environment variable not set'
    );
    process.exit(1);
  }

  try {
    const orchestrator = new Orchestrator();

    // Phase 1: Automatic
    const state = await orchestrator.runPhase1(
      instruction,
      owner,
      repoName,
      {
        projectMode: options.projectMode || 'new',
      }
    );

    logger.section('PHASE 1 RESULTS');
    console.log(`\nProject: ${state.githubRepo}`);
    console.log(`Repository: https://github.com/${owner}/${repoName}`);
    console.log(`Tasks created: ${state.tasks.length}`);
    console.log(`\nTask List:`);
    console.log(
      `${'#'.padEnd(3)} ${'Task'.padEnd(50)} ${'Issue'.padEnd(8)} ${'Status'.padEnd(10)}`
    );
    console.log('-'.repeat(80));
    state.tasks.forEach((task, i) => {
      const issueStatus = task.issueNumber ? `#${task.issueNumber}` : '-';
      console.log(
        `${(i + 1).toString().padEnd(3)} ${task.title.padEnd(50)} ${issueStatus.padEnd(8)} ${task.status.padEnd(10)}`
      );
    });

    if (autoPhase2) {
      logger.section('Starting Phase 2...');
      await orchestrator.runPhase2(retryFailed);

      const finalState = await stateManager.load();
      if (finalState) {
        printFinalState(finalState);
      }
    } else {
      console.log(
        '\nPhase 1 complete! Requirements, design, and tasks have been generated.'
      );
      console.log(
        'To proceed with Phase 2 (coding/review/merge):'
      );
      console.log('\n  npx tsx src/index.ts phase2\n');
    }
  } catch (err) {
    if (isLlmUsageLimitError(err)) {
      await printLlmLimitNotice(err);
      process.exit(2);
    }

    logger.error('Orchestration failed', err);
    process.exit(1);
  }
}

type LimitProvider = 'claude' | 'codex' | 'gemini' | 'all';

async function cmdPhase2(
  retryFailed: boolean = false,
  options: {
    loopUntilLimit?: boolean;
    limitProvider?: LimitProvider;
  } = {}
) {
  logger.section('AUTO CODING ECOSYSTEM - PHASE 2');

  const stateManager = new StateManager();
  const state = await stateManager.load();

  if (!state || !state.tasks || state.tasks.length === 0) {
    console.error('No project state or tasks found.');
    console.error(
      'Run: npx tsx src/index.ts start --instruction "..." --repo-name "..."'
    );
    process.exit(1);
  }

  try {
    configureAiTokenMode(options.limitProvider || 'all');

    if (options.loopUntilLimit) {
      await runPhase2Loop(options.limitProvider || 'all');
    } else {
      const orchestrator = new Orchestrator();
      await orchestrator.runPhase2(retryFailed);

      const finalState = await stateManager.load();
      if (finalState) {
        printFinalState(finalState);
      }
    }
  } catch (err) {
    if (isLlmUsageLimitError(err)) {
      await printLlmLimitNotice(err);
      process.exit(2);
    }

    logger.error('Phase 2 failed', err);
    process.exit(1);
  }
}

async function runPhase2Loop(limitProvider: LimitProvider): Promise<void> {
  const maxAttempts = Number(process.env.PHASE2_LOOP_MAX_ATTEMPTS || '100');

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    logger.section(`PHASE 2 RETRY LOOP ${attempt}/${maxAttempts}`);
    configureAiTokenMode(limitProvider);

    const orchestrator = new Orchestrator();
    await orchestrator.runPhase2(true);

    const latestState = await new StateManager().load();
    if (latestState) {
      printFinalState(latestState);
      const failedCount = latestState.tasks.filter((task) => task.status === 'failed').length;
      if (failedCount === 0) {
        logger.section('PHASE 2 RETRY LOOP COMPLETE');
        return;
      }
    }
  }

  logger.warn(
    'Phase 2 retry loop stopped by max attempts',
    `PHASE2_LOOP_MAX_ATTEMPTS=${maxAttempts}`
  );
}

function configureAiTokenMode(limitProvider: LimitProvider): void {
  process.env.AI_TOKEN_MODE = limitProvider;

  if (limitProvider === 'claude') {
    process.env.PLANNING_LLM_PROVIDER = 'claude';
    process.env.IMPLEMENTATION_LLM_PROVIDER = 'claude';
  } else if (limitProvider === 'codex') {
    process.env.PLANNING_LLM_PROVIDER = 'codex';
    process.env.IMPLEMENTATION_LLM_PROVIDER = 'codex';
  } else if (limitProvider === 'gemini') {
    process.env.PLANNING_LLM_PROVIDER = 'gemini';
    process.env.IMPLEMENTATION_LLM_PROVIDER = 'gemini';
  } else {
    process.env.PLANNING_LLM_PROVIDER = 'claude';
    process.env.IMPLEMENTATION_LLM_PROVIDER = 'claude';
  }
}

async function printLlmLimitNotice(err: LlmUsageLimitError): Promise<void> {
  logger.section(`${err.provider.toUpperCase()} LIMIT REACHED - PAUSED`);
  console.error(`\n${err.provider} の利用上限に達したため、処理をここで切り上げました。`);
  console.error('利用枠の回復後、次のコマンドで失敗タスクから再開できます:\n');
  console.error('  npm run dev -- phase2 --retry-failed\n');
  console.error('ループ再開する場合:\n');
  console.error('  npm run dev -- phase2 --retry-failed --loop-until-limit --limit-provider all\n');
  console.error(`詳細: ${err.message.slice(0, 1000)}\n`);

  const latestState = await new StateManager().load().catch(() => null);
  if (latestState) {
    printFinalState(latestState);
  }
}

function printFinalState(state: Awaited<ReturnType<StateManager['load']>>): void {
  if (!state) return;

  const failedCount = state.tasks.filter((task) => task.status === 'failed').length;
  const mergedCount = state.tasks.filter((task) => task.status === 'merged').length;

  logger.section(failedCount > 0 ? 'PHASE 2 FINISHED WITH FAILURES' : 'FINAL RESULTS');
  console.log(`\nRepository: https://github.com/${state.githubOwner}/${state.githubRepo}`);
  console.log(`Merged: ${mergedCount}/${state.tasks.length}`);
  console.log(`Failed: ${failedCount}/${state.tasks.length}`);
  console.log(`\nFinal Task Status:`);
  console.log(
    `${'#'.padEnd(3)} ${'Task'.padEnd(40)} ${'Status'.padEnd(12)} ${'Issue'.padEnd(8)} ${'PR'.padEnd(6)} ${'Details'}`
  );
  console.log('-'.repeat(120));
  state.tasks.forEach((task, i) => {
    const issueStatus = task.issueNumber ? `#${task.issueNumber}` : '-';
    const prStatus = task.prNumber ? `#${task.prNumber}` : '-';
    console.log(
      `${(i + 1).toString().padEnd(3)} ${truncate(task.title, 40).padEnd(40)} ${task.status.padEnd(12)} ${issueStatus.padEnd(8)} ${prStatus.padEnd(6)} ${getTaskDetails(task)}`
    );
  });
}

async function cmdStatus() {
  logger.section('PROJECT STATUS');

  const stateManager = new StateManager();
  const state = await stateManager.load();

  if (!state) {
    console.log('No project state found.');
    process.exit(0);
  }

  console.log(`Project ID: ${state.projectId}`);
  console.log(`Phase: ${state.phase}`);
  console.log(`Mode: ${state.projectMode || 'new'}`);
  console.log(
    `Repository: ${state.githubOwner}/${state.githubRepo}`
  );
  console.log();

  if (state.tasks && state.tasks.length > 0) {
    console.log(
      `${'#'.padEnd(3)} ${'Task'.padEnd(40)} ${'Status'.padEnd(12)} ${'Issue'.padEnd(8)} ${'PR'.padEnd(6)} ${'Details'}`
    );
    console.log('-'.repeat(120));
    state.tasks.forEach((task, i) => {
      const issueStatus = task.issueNumber ? `#${task.issueNumber}` : '-';
      const prStatus = task.prNumber ? `#${task.prNumber}` : '-';
      console.log(
        `${(i + 1).toString().padEnd(3)} ${truncate(task.title, 40).padEnd(40)} ${task.status.padEnd(12)} ${issueStatus.padEnd(8)} ${prStatus.padEnd(6)} ${getTaskDetails(task)}`
      );
    });
  } else {
    console.log('No tasks yet.');
  }

  console.log();
}

function getTaskDetails(task: NonNullable<Awaited<ReturnType<StateManager['load']>>>['tasks'][number]): string {
  if (task.status === 'failed' && task.errorMessage) {
    return truncate(cleanOneLine(task.errorMessage), 80);
  }

  if (task.reviewIteration > 0) {
    return `review iteration ${task.reviewIteration}`;
  }

  return '-';
}

function cleanOneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    console.log('Usage: npx tsx src/index.ts <command> [options]');
    console.log();
    console.log('Commands:');
    console.log(
      '  start --instruction <text> --repo-name <name> [--auto]'
    );
    console.log(
      '  start --instruction-file <path> --repo-name <name> [--auto]'
    );
    console.log(
      '  modify --target-repo <owner/repo|repo> --instruction-file <path> [--auto]'
    );
    console.log('    Start Phase 1 (requirements, design, tasks)');
    console.log('    Use --auto to automatically continue to Phase 2');
    console.log();
    console.log('  phase2 [--retry-failed] [--loop-until-limit] [--limit-provider claude|codex|gemini|all]');
    console.log('    Start Phase 2 (coding, review, merge)');
    console.log();
    console.log('  status');
    console.log('    Show project status');
    console.log();
    console.log('Model options (any command):');
    console.log('  --claude-model <model-id>    Set both planning and implementation Claude model');
    console.log('  --planning-model <model-id>  Set Claude model for planning agents only');
    console.log('  --impl-model <model-id>      Set Claude model for implementation agents only');
    process.exit(1);
  }

  applyModelOptions(args);

  const command = args[0];

  try {
    if (command === 'start' || command === 'modify') {
      let instruction: string | null = null;
      let instructionFile: string | null = null;
      let repoName: string | null = null;
      let ownerOverride: string | undefined;
      let autoPhase2 = false;
      let retryFailed = false;

      for (let i = 1; i < args.length; i++) {
        if (
          args[i] === '--instruction' &&
          i + 1 < args.length
        ) {
          instruction = args[i + 1];
          i++;
        } else if (
          args[i] === '--instruction-file' &&
          i + 1 < args.length
        ) {
          instructionFile = args[i + 1];
          i++;
        } else if (
          args[i] === '--repo-name' &&
          i + 1 < args.length
        ) {
          repoName = args[i + 1];
          i++;
        } else if (
          args[i] === '--target-repo' &&
          i + 1 < args.length
        ) {
          const targetRepo = args[i + 1];
          const parts = targetRepo.split('/');
          if (parts.length === 2) {
            ownerOverride = parts[0];
            repoName = parts[1];
          } else {
            repoName = targetRepo;
          }
          i++;
        } else if (args[i] === '--auto') {
          autoPhase2 = true;
        } else if (args[i] === '--retry-failed') {
          retryFailed = true;
        }
      }

      if (instructionFile) {
        instruction = await fs.readFile(instructionFile, 'utf-8');
      }

      if (!instruction || !repoName) {
        console.error(
          command === 'modify'
            ? 'Error: --target-repo and --instruction or --instruction-file are required'
            : 'Error: --instruction or --instruction-file, and --repo-name are required'
        );
        process.exit(1);
      }

      await cmdStart(instruction, repoName, autoPhase2, retryFailed, {
        projectMode: command === 'modify' ? 'modify' : 'new',
        ownerOverride,
      });
    } else if (command === 'phase2') {
      const loopUntilLimit = args.includes('--loop-until-limit');
      const limitProvider = parseLimitProvider(args);
      await cmdPhase2(args.includes('--retry-failed') || loopUntilLimit, {
        loopUntilLimit,
        limitProvider,
      });
    } else if (command === 'status') {
      await cmdStatus();
    } else {
      console.error(`Unknown command: ${command}`);
      process.exit(1);
    }
  } catch (err) {
    logger.error('Command failed', err);
    process.exit(1);
  }
}

const stateManager = new StateManager();
main();

function applyModelOptions(args: string[]): void {
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
    }
  }
}

function parseLimitProvider(args: string[]): LimitProvider {
  const index = args.indexOf('--limit-provider');
  if (index === -1) {
    return 'all';
  }

  const value = args[index + 1];
  if (value === 'claude' || value === 'codex' || value === 'gemini' || value === 'all') {
    return value as LimitProvider;
  }

  throw new Error('--limit-provider must be one of: claude, codex, gemini, all');
}
