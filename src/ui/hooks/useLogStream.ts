import { useState, useEffect } from 'react';
import { bus, LogEvent } from '../../events.js';

export function useLogStream(maxLines = 200): LogEvent[] {
  const [logs, setLogs] = useState<LogEvent[]>([]);

  useEffect(() => {
    const handler = (ev: LogEvent) => {
      setLogs((prev) =>
        prev.length >= maxLines ? [...prev.slice(1), ev] : [...prev, ev]
      );
    };
    bus.on('log', handler);
    return () => { bus.off('log', handler); };
  }, [maxLines]);

  return logs;
}
