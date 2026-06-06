import { describe, it, expect } from 'vitest';
import { filterLogEvents, getLogStreamView } from '../../ui/components/LogStream.js';
import type { LogEvent } from '../../events.js';

function log(message: string, overrides: Partial<LogEvent> = {}): LogEvent {
  return {
    ts: Date.now(),
    source: 'info',
    level: 'info',
    message,
    ...overrides,
  };
}

describe('LogStream view helpers', () => {
  it('検索語でログを絞り込む', () => {
    const logs = [log('build started'), log('test failed'), log('build completed')];

    expect(filterLogEvents(logs, { searchTerm: 'BUILD' }).map((item) => item.message)).toEqual([
      'build started',
      'build completed',
    ]);
  });

  it('level と source でログを絞り込む', () => {
    const logs = [
      log('info', { level: 'info', source: 'info' }),
      log('warn', { level: 'warn', source: 'agent' }),
      log('github warn', { level: 'warn', source: 'github' }),
      log('github error', { level: 'error', source: 'github' }),
    ];

    expect(filterLogEvents(logs, {
      levelFilter: ['warn', 'error'],
      sourceFilter: ['github'],
    }).map((item) => item.message)).toEqual(['github warn', 'github error']);
  });

  it('scrollOffset で末尾から過去ログへ移動する', () => {
    const logs = [log('1'), log('2'), log('3'), log('4'), log('5')];

    const latest = getLogStreamView(logs, { visibleLines: 2, follow: true });
    const older = getLogStreamView(logs, { visibleLines: 2, follow: false, scrollOffset: 2 });

    expect(latest.visible.map((item) => item.message)).toEqual(['4', '5']);
    expect(older.visible.map((item) => item.message)).toEqual(['2', '3']);
  });
});
