import { useState, useEffect } from 'react';
import { bus, LogEvent } from '../../events.js';
import { StateManager } from '../../state/manager.js';
import type { Task, ProjectState, ProjectPhase } from '../../state/types.js';

export interface EcosystemState {
  isLoaded: boolean;
  owner: string;
  repo: string;
  phase: ProjectPhase | null;
  tasks: Task[];
  currentTaskIndex: number;
  logs: LogEvent[];
  error: string | null;
}

export function useEcosystemState(): EcosystemState {
  const [state, setState] = useState<EcosystemState>({
    isLoaded: false,
    owner: '',
    repo: '',
    phase: null,
    tasks: [],
    currentTaskIndex: 0,
    logs: [],
    error: null,
  });

  useEffect(() => {
    const manager = new StateManager();
    manager.load().then((projectState) => {
      if (projectState) {
        setState((prev) => ({
          ...prev,
          owner: projectState.githubOwner,
          repo: projectState.githubRepo,
          phase: projectState.phase,
          tasks: projectState.tasks,
          currentTaskIndex: projectState.currentTaskIndex,
          isLoaded: true,
        }));
      } else {
        setState((prev) => ({ ...prev, isLoaded: true }));
      }
    }).catch((err) => {
      setState((prev) => ({ ...prev, isLoaded: true, error: String(err) }));
    });

    const onLog = (ev: LogEvent) => {
      setState((prev) => ({
        ...prev,
        logs: prev.logs.length >= 500
          ? [...prev.logs.slice(1), ev]
          : [...prev.logs, ev],
      }));
    };

    const onTaskUpdate = ({ taskId, changes }: { taskId: string; changes: Partial<Task> }) => {
      setState((prev) => ({
        ...prev,
        tasks: prev.tasks.map((t) =>
          t.id === taskId ? { ...t, ...changes } : t
        ),
      }));
    };

    const onTasksSet = ({ tasks }: { tasks: Task[] }) => {
      setState((prev) => ({ ...prev, tasks }));
    };

    const onPhaseChange = ({ phase }: { phase: ProjectPhase }) => {
      setState((prev) => ({ ...prev, phase }));
    };

    const onStateInit = ({ state: s }: { state: ProjectState }) => {
      setState((prev) => ({
        ...prev,
        owner: s.githubOwner,
        repo: s.githubRepo,
        phase: s.phase,
        tasks: s.tasks,
        currentTaskIndex: s.currentTaskIndex,
      }));
    };

    const onCurrentTaskChange = ({ index }: { index: number }) => {
      setState((prev) => ({ ...prev, currentTaskIndex: index }));
    };

    bus.on('log', onLog);
    bus.on('task:update', onTaskUpdate);
    bus.on('tasks:set', onTasksSet);
    bus.on('phase:change', onPhaseChange);
    bus.on('state:init', onStateInit);
    bus.on('currentTask:change', onCurrentTaskChange);

    return () => {
      bus.off('log', onLog);
      bus.off('task:update', onTaskUpdate);
      bus.off('tasks:set', onTasksSet);
      bus.off('phase:change', onPhaseChange);
      bus.off('state:init', onStateInit);
      bus.off('currentTask:change', onCurrentTaskChange);
    };
  }, []);

  return state;
}
