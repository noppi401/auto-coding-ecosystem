// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { bus } from '../../events.js';
import type { LogEvent } from '../../events.js';

vi.mock('../../utils/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

function makeLogEvent(message: string, level: LogEvent['level'] = 'info'): LogEvent {
  return { ts: Date.now(), source: 'info', level, message };
}

describe('useLogStream', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('初期状態は空配列', async () => {
    const { useLogStream } = await import('../../ui/hooks/useLogStream.js');
    const { result } = renderHook(() => useLogStream());
    expect(result.current).toEqual([]);
  });

  it('log イベントを受信してリストに追加する', async () => {
    const { useLogStream } = await import('../../ui/hooks/useLogStream.js');
    const { result } = renderHook(() => useLogStream());

    const ev = makeLogEvent('Hello world');
    act(() => {
      bus.emit('log', ev);
    });

    expect(result.current).toHaveLength(1);
    expect(result.current[0].message).toBe('Hello world');
  });

  it('複数ログを順に追加する', async () => {
    const { useLogStream } = await import('../../ui/hooks/useLogStream.js');
    const { result } = renderHook(() => useLogStream());

    act(() => {
      bus.emit('log', makeLogEvent('First'));
      bus.emit('log', makeLogEvent('Second'));
      bus.emit('log', makeLogEvent('Third'));
    });

    expect(result.current).toHaveLength(3);
    expect(result.current[0].message).toBe('First');
    expect(result.current[2].message).toBe('Third');
  });

  it('maxLines を超えたとき古いログをトリムする', async () => {
    const { useLogStream } = await import('../../ui/hooks/useLogStream.js');
    const maxLines = 3;
    const { result } = renderHook(() => useLogStream(maxLines));

    act(() => {
      bus.emit('log', makeLogEvent('A'));
      bus.emit('log', makeLogEvent('B'));
      bus.emit('log', makeLogEvent('C'));
      bus.emit('log', makeLogEvent('D'));
    });

    expect(result.current).toHaveLength(maxLines);
    expect(result.current[0].message).toBe('B');
    expect(result.current[2].message).toBe('D');
  });

  it('アンマウント後はログが追加されない', async () => {
    const { useLogStream } = await import('../../ui/hooks/useLogStream.js');
    const { result, unmount } = renderHook(() => useLogStream());

    act(() => { bus.emit('log', makeLogEvent('Before unmount')); });
    expect(result.current).toHaveLength(1);

    unmount();

    act(() => { bus.emit('log', makeLogEvent('After unmount')); });
    expect(result.current).toHaveLength(1);
  });
});
