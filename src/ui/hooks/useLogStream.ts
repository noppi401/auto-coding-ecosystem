import { useState, useEffect } from 'react';
import { bus, LogEvent } from '../../events.js';

export function useLogStream(maxLines = 200, levels?: LogEvent['level'][]): LogEvent[] {
  const [logs, setLogs] = useState<LogEvent[]>([]);
  const levelKey = levels?.join('|') ?? '';

  useEffect(() => {
    const handler = (ev: LogEvent) => {
      if (levels && !levels.includes(ev.level)) return;
      setLogs((prev) =>
        prev.length >= maxLines ? [...prev.slice(1), ev] : [...prev, ev]
      );
    };
    bus.on('log', handler);
    return () => { bus.off('log', handler); };
  }, [maxLines, levelKey]);

  return logs;
}
