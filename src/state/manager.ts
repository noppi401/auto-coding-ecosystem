import { promises as fs } from 'fs';
import { dirname, join } from 'path';
import { randomUUID } from 'crypto';
import {
  ProjectState,
  Task,
  TaskStatus,
  ProjectPhase,
} from './types.js';
import { logger } from '../utils/logger.js';

export class StateManager {
  private statePath: string;

  constructor(statePath: string = '.ecosystem/state.json') {
    this.statePath = statePath;
  }

  async initialize(
    instruction: string,
    owner: string,
    repo: string,
    options: {
      projectMode?: ProjectState['projectMode'];
      repositoryContext?: string;
    } = {}
  ): Promise<ProjectState> {
    const state: ProjectState = {
      projectId: randomUUID(),
      phase: 'requirements',
      projectMode: options.projectMode || 'new',
      userInstruction: instruction,
      githubOwner: owner,
      githubRepo: repo,
      repositoryContext: options.repositoryContext,
      requirementsDoc: '',
      designDoc: '',
      tasks: [],
      currentTaskIndex: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      agentHistories: {
        requirements: null,
        design: null,
        taskDecomp: null,
        coding: null,
        codexReview: null,
        codexFix: null,
        review: null,
        fix: null,
      },
    };

    await this.save(state);
    return state;
  }

  async load(): Promise<ProjectState | null> {
    try {
      const data = await fs.readFile(this.statePath, 'utf-8');
      return JSON.parse(data) as ProjectState;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      logger.error('Failed to load state', err);
      throw err;
    }
  }

  async save(state: ProjectState): Promise<void> {
    try {
      state.updatedAt = new Date().toISOString();
      const dir = dirname(this.statePath);
      await fs.mkdir(dir, { recursive: true });

      // Atomic write: temp file -> rename
      const tmpPath = `${this.statePath}.tmp`;
      await fs.writeFile(tmpPath, JSON.stringify(state, null, 2));
      await fs.rename(tmpPath, this.statePath);
    } catch (err) {
      logger.error('Failed to save state', err);
      throw err;
    }
  }

  async updateRequirementsDoc(doc: string): Promise<void> {
    const state = await this.load();
    if (!state) throw new Error('No project state found');
    state.requirementsDoc = doc;
    state.phase = 'design';
    await this.save(state);
  }

  async updateDesignDoc(doc: string): Promise<void> {
    const state = await this.load();
    if (!state) throw new Error('No project state found');
    state.designDoc = doc;
    state.phase = 'task_decomp';
    await this.save(state);
  }

  async setTasks(tasks: Task[]): Promise<void> {
    const state = await this.load();
    if (!state) throw new Error('No project state found');
    state.tasks = tasks;
    state.phase = 'awaiting_approval';
    await this.save(state);
  }

  async updateTask(
    taskId: string,
    updates: Partial<Task>
  ): Promise<void> {
    const state = await this.load();
    if (!state) throw new Error('No project state found');

    const task = state.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    Object.assign(task, updates, { updatedAt: new Date().toISOString() });
    await this.save(state);
  }

  async setCurrentTaskIndex(index: number): Promise<void> {
    const state = await this.load();
    if (!state) throw new Error('No project state found');
    state.currentTaskIndex = index;
    await this.save(state);
  }

  async markCompleted(): Promise<void> {
    const state = await this.load();
    if (!state) throw new Error('No project state found');
    state.phase = 'completed';
    await this.save(state);
  }

  async updateAgentHistory(
    agent: keyof ProjectState['agentHistories'],
    sessionId: string | null
  ): Promise<void> {
    const state = await this.load();
    if (!state) throw new Error('No project state found');
    state.agentHistories[agent] = sessionId;
    await this.save(state);
  }
}
