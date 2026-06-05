import { EventEmitter } from 'node:events';
import type { Task, ProjectState, ProjectPhase } from './state/types.js';

export type LogSource = 'agent' | 'github' | 'coding' | 'review' | 'queue' | 'error' | 'info' | 'warn';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEvent {
  ts: number;
  source: LogSource;
  level: LogLevel;
  message: string;
  data?: unknown;
}

interface BusEvents {
  log: LogEvent;
  'task:update': { taskId: string; changes: Partial<Task> };
  'phase:change': { phase: ProjectPhase };
  'tasks:set': { tasks: Task[] };
  'state:init': { state: ProjectState };
  'currentTask:change': { index: number };
  // Issue #3: タスク分解結果の承認フロー（Ink UI 用）
  'tasks:preview': { tasks: Task[] };
  'tasks:approval': { approved: boolean };
}

class TypedBus extends EventEmitter {
  emit<K extends keyof BusEvents>(event: K, data: BusEvents[K]): boolean {
    return super.emit(event as string, data);
  }

  on<K extends keyof BusEvents>(event: K, listener: (data: BusEvents[K]) => void): this {
    return super.on(event as string, listener);
  }

  off<K extends keyof BusEvents>(event: K, listener: (data: BusEvents[K]) => void): this {
    return super.off(event as string, listener);
  }
}

export const bus = new TypedBus();
