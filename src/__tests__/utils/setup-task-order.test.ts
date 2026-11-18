import { describe, it, expect } from 'vitest';
import { moveSetupTaskFirst } from '../../utils/setup-task-order.js';

const t = (title: string, targetFiles: string[]) => ({ title, targetFiles });

describe('moveSetupTaskFirst', () => {
  it('設定ファイルだけを作るタスクが後ろにあれば先頭に移す（run 30: package.json が 10 番目だった）', () => {
    const tasks = [t('server', ['src/server.js']), t('store', ['src/store.js']), t('config', ['package.json', '.gitignore', 'README.md'])];
    const { tasks: out, moved } = moveSetupTaskFirst(tasks);
    expect(out.map((x) => x.title)).toEqual(['config', 'server', 'store']);
    expect(moved).toBe('config');
  });

  it('すでに先頭に package.json を作るタスクがあれば何もしない', () => {
    const tasks = [t('setup', ['package.json', 'src/server.js']), t('config', ['README.md'])];
    const { tasks: out, moved } = moveSetupTaskFirst(tasks);
    expect(out).toEqual(tasks);
    expect(moved).toBeUndefined();
  });

  it('package.json を含むタスクが実装ファイルも含む場合は、順序を崩さないよう移さず warning を返す', () => {
    const tasks = [t('store', ['src/store.js']), t('server', ['src/server.js', 'package.json'])];
    const { tasks: out, moved, warning } = moveSetupTaskFirst(tasks);
    expect(out).toEqual(tasks);
    expect(moved).toBeUndefined();
    expect(warning).toContain('server');
  });

  it('package.json を作るタスクが無ければ何もしない', () => {
    const tasks = [t('a', ['src/a.js'])];
    expect(moveSetupTaskFirst(tasks)).toEqual({ tasks });
  });
});
