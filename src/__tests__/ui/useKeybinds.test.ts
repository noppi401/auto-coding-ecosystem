// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const inkMock = vi.hoisted(() => ({
  handlers: new Set<(input: string, key: any) => void>(),
  useInput: vi.fn(),
}));

vi.mock('ink', async () => {
  const React = await import('react');
  inkMock.useInput.mockImplementation((handler: (input: string, key: any) => void, options?: { isActive?: boolean }) => {
    React.useEffect(() => {
      inkMock.handlers.add(handler);
      return () => { inkMock.handlers.delete(handler); };
    }, [handler, options?.isActive]);
  });
  return { useInput: inkMock.useInput };
});

function press(input: string, key: any = {}): void {
  for (const handler of [...inkMock.handlers]) {
    handler(input, key);
  }
}

describe('useKeybinds', () => {
  beforeEach(() => {
    inkMock.handlers.clear();
    inkMock.useInput.mockClear();
  });

  it('登録したキーバインドが押下時にハンドラを呼び出す', async () => {
    const { useKeybinds } = await import('../../ui/hooks/useKeybinds.js');
    const up = vi.fn();
    const enter = vi.fn();
    const custom = vi.fn();

    renderHook(() => useKeybinds({ up, return: enter, a: custom }));

    act(() => {
      press('', { upArrow: true });
      press('\r', {});
      press('A', {});
    });

    expect(up).toHaveBeenCalledOnce();
    expect(enter).toHaveBeenCalledOnce();
    expect(custom).toHaveBeenCalledOnce();
  });

  it('active=false のときハンドラを呼び出さない', async () => {
    const { useKeybinds } = await import('../../ui/hooks/useKeybinds.js');
    const down = vi.fn();

    renderHook(() => useKeybinds({ down }, false));

    act(() => {
      press('', { downArrow: true });
    });

    expect(down).not.toHaveBeenCalled();
    expect(inkMock.useInput).toHaveBeenCalledWith(expect.any(Function), { isActive: false });
  });

  it('アンマウント時に登録を解除する', async () => {
    const { useKeybinds } = await import('../../ui/hooks/useKeybinds.js');
    const escape = vi.fn();
    const { unmount } = renderHook(() => useKeybinds({ escape }));

    expect(inkMock.handlers.size).toBe(1);
    unmount();
    expect(inkMock.handlers.size).toBe(0);

    act(() => {
      press('\u001b', {});
    });

    expect(escape).not.toHaveBeenCalled();
  });
});
