import { useInput, Key } from 'ink';

export type KeyBindings = {
  up?: () => void;
  down?: () => void;
  return?: () => void;
  escape?: () => void;
  [key: string]: (() => void) | undefined;
};

export function useKeybinds(bindings: KeyBindings, active = true): void {
  useInput((input: string, key: Key) => {
    if (!active) return;

    if (key.upArrow)   { bindings.up?.();     return; }
    if (key.downArrow) { bindings.down?.();   return; }
    if (key.return || input === '\r' || input === '\n') {
      bindings.return?.();
      return;
    }
    if (key.escape || input === '\u001b') {
      bindings.escape?.();
      return;
    }

    const normalized = input.length === 1 ? input.toLowerCase() : input;

    if (input && bindings[input]) {
      bindings[input]!();
      return;
    }

    if (normalized && bindings[normalized]) {
      bindings[normalized]!();
    }
  }, { isActive: active });
}
