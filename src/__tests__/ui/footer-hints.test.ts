import { describe, it, expect } from 'vitest';
import { keyHints } from '../../ui/theme.js';
import { resolveRunFooterScope } from '../../ui/footer-scope.js';

function keys(scope: keyof typeof keyHints): string[] {
  return keyHints[scope].map((hint) => hint.key);
}

describe('FooterHints scopes', () => {
  it('通常実行中は recovery 専用キーを表示しない', () => {
    expect(keys('run')).not.toEqual(expect.arrayContaining(['r', 'R', 's']));
  });

  it('リカバリ中だけ retry / model upgrade / skip を表示する', () => {
    expect(keys('recovery')).toEqual(expect.arrayContaining(['r', 'R', 's']));
  });

  it('ログ画面は RunScreen で実際に処理されるキーだけを表示する', () => {
    expect(keys('log')).toEqual(['j/k', 'g/G', '/', 'f', 'p', 'Esc', 'q']);
  });

  it('RunScreen の状態から footer scope を解決する', () => {
    expect(resolveRunFooterScope({
      showLog: false,
      inRecovery: false,
      hasPreview: false,
      awaitingPhase2Start: false,
    })).toBe('run');
    expect(resolveRunFooterScope({
      showLog: false,
      inRecovery: true,
      hasPreview: false,
      awaitingPhase2Start: false,
    })).toBe('recovery');
    expect(resolveRunFooterScope({
      showLog: false,
      inRecovery: false,
      hasPreview: true,
      awaitingPhase2Start: false,
    })).toBe('approval');
    expect(resolveRunFooterScope({
      showLog: false,
      inRecovery: false,
      hasPreview: false,
      awaitingPhase2Start: true,
    })).toBe('phase2Start');
    expect(resolveRunFooterScope({
      showLog: true,
      inRecovery: true,
      hasPreview: true,
      awaitingPhase2Start: true,
    })).toBe('log');
  });
});
