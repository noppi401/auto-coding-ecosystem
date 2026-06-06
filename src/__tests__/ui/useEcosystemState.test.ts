// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { bus } from '../../events.js';
import { randomUUID } from 'crypto';
import type { Task, ProjectState } from '../../state/types.js';

vi.mock('../../utils/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../events.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../events.js')>();
  return actual;
});

vi.mock('../../state/manager.js', () => ({
  StateManager: vi.fn().mockImplementation(function() {
    return { load: vi.fn().mockResolvedValue(null) };
  }),
}));

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: randomUUID(),
    title: 'Test task',
    summary: 'summary',
    branchName: 'feat/test',
    targetFiles: [],
    status: 'pending',
    reviewIteration: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('useEcosystemState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('初期状態: isLoaded=false で各フィールドが初期値', async () => {
    const { useEcosystemState } = await import('../../ui/hooks/useEcosystemState.js');
    const { result } = renderHook(() => useEcosystemState());

    expect(result.current.isLoaded).toBe(false);
    expect(result.current.owner).toBe('');
    expect(result.current.tasks).toEqual([]);
    expect(result.current.phase).toBeNull();
  });

  it('StateManager.load() が null を返すとき isLoaded=true になる', async () => {
    const { useEcosystemState } = await import('../../ui/hooks/useEcosystemState.js');
    const { result } = renderHook(() => useEcosystemState());

    await waitFor(() => expect(result.current.isLoaded).toBe(true));
    expect(result.current.owner).toBe('');
  });

  it('StateManager.load() が state を返すとき owner/repo/phase が反映される', async () => {
    const { StateManager } = await import('../../state/manager.js');
    const mockState: Partial<ProjectState> = {
      githubOwner: 'myowner',
      githubRepo: 'myrepo',
      phase: 'coding_loop',
      tasks: [],
      currentTaskIndex: 0,
    };
    vi.mocked(StateManager).mockImplementationOnce(function() {
      return { load: vi.fn().mockResolvedValue(mockState) } as any;
    });

    const { useEcosystemState } = await import('../../ui/hooks/useEcosystemState.js');
    const { result } = renderHook(() => useEcosystemState());

    await waitFor(() => expect(result.current.isLoaded).toBe(true));
    expect(result.current.owner).toBe('myowner');
    expect(result.current.repo).toBe('myrepo');
    expect(result.current.phase).toBe('coding_loop');
  });

  it('state:init イベントで owner/repo/phase が更新される', async () => {
    const { useEcosystemState } = await import('../../ui/hooks/useEcosystemState.js');
    const { result } = renderHook(() => useEcosystemState());

    await waitFor(() => expect(result.current.isLoaded).toBe(true));

    act(() => {
      bus.emit('state:init', {
        state: {
          githubOwner: 'new-owner',
          githubRepo: 'new-repo',
          phase: 'design',
          tasks: [],
          currentTaskIndex: 0,
        } as any,
      });
    });

    expect(result.current.owner).toBe('new-owner');
    expect(result.current.phase).toBe('design');
  });

  it('phase:change イベントで phase が更新される', async () => {
    const { useEcosystemState } = await import('../../ui/hooks/useEcosystemState.js');
    const { result } = renderHook(() => useEcosystemState());

    await waitFor(() => expect(result.current.isLoaded).toBe(true));

    act(() => { bus.emit('phase:change', { phase: 'completed' }); });

    expect(result.current.phase).toBe('completed');
  });

  it('tasks:set イベントで tasks が置き換わる', async () => {
    const { useEcosystemState } = await import('../../ui/hooks/useEcosystemState.js');
    const { result } = renderHook(() => useEcosystemState());

    await waitFor(() => expect(result.current.isLoaded).toBe(true));

    const tasks = [makeTask({ title: 'Task A' }), makeTask({ title: 'Task B' })];
    act(() => { bus.emit('tasks:set', { tasks }); });

    expect(result.current.tasks).toHaveLength(2);
    expect(result.current.tasks[0].title).toBe('Task A');
  });

  it('task:update イベントで特定タスクのステータスが更新される', async () => {
    const { StateManager } = await import('../../state/manager.js');
    const task = makeTask({ title: 'My Task' });
    vi.mocked(StateManager).mockImplementationOnce(function() {
      return {
        load: vi.fn().mockResolvedValue({
          githubOwner: 'owner',
          githubRepo: 'repo',
          phase: 'coding_loop',
          tasks: [task],
          currentTaskIndex: 0,
        }),
      } as any;
    });

    const { useEcosystemState } = await import('../../ui/hooks/useEcosystemState.js');
    const { result } = renderHook(() => useEcosystemState());

    await waitFor(() => expect(result.current.isLoaded).toBe(true));

    act(() => {
      bus.emit('task:update', { taskId: task.id, changes: { status: 'coding' } });
    });

    const updated = result.current.tasks.find((t) => t.id === task.id);
    expect(updated?.status).toBe('coding');
  });

  it('currentTask:change イベントで currentTaskIndex が更新される', async () => {
    const { useEcosystemState } = await import('../../ui/hooks/useEcosystemState.js');
    const { result } = renderHook(() => useEcosystemState());

    await waitFor(() => expect(result.current.isLoaded).toBe(true));

    act(() => { bus.emit('currentTask:change', { index: 3 }); });

    expect(result.current.currentTaskIndex).toBe(3);
  });

  it('StateManager.load() がエラーを返すとき error フィールドが設定される', async () => {
    const { StateManager } = await import('../../state/manager.js');
    vi.mocked(StateManager).mockImplementationOnce(function() {
      return { load: vi.fn().mockRejectedValue(new Error('load failed')) } as any;
    });

    const { useEcosystemState } = await import('../../ui/hooks/useEcosystemState.js');
    const { result } = renderHook(() => useEcosystemState());

    await waitFor(() => expect(result.current.isLoaded).toBe(true));
    expect(result.current.error).toContain('load failed');
  });
});
