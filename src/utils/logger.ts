import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { bus, LogEvent, LogLevel, LogSource } from '../events.js';

const LOG_PATH = '.ecosystem/log/current.jsonl';

export const isPlainMode = (): boolean =>
  process.argv.includes('--plain') || !process.stdout.isTTY;

async function writeToFile(ev: LogEvent): Promise<void> {
  try {
    await mkdir(dirname(LOG_PATH), { recursive: true });
    await appendFile(LOG_PATH, JSON.stringify(ev) + '\n');
  } catch {
    // file logging failure is non-fatal
  }
}

function levelToSource(level: LogLevel): LogSource {
  if (level === 'error') return 'error';
  if (level === 'warn') return 'warn';
  return 'info';
}

class Logger {
  private logLevel: LogLevel;

  constructor(level: LogLevel = 'info') {
    this.logLevel = level;
  }

  private shouldLog(level: LogLevel): boolean {
    const order: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    return order.indexOf(level) >= order.indexOf(this.logLevel);
  }

  private emit(level: LogLevel, message: string, data?: unknown): void {
    if (!this.shouldLog(level)) return;

    const ev: LogEvent = {
      ts: Date.now(),
      source: levelToSource(level),
      level,
      message,
      data,
    };

    bus.emit('log', ev);
    void writeToFile(ev);

    if (isPlainMode()) {
      const tag = level === 'error' ? '[ERROR]' : level === 'warn' ? '[WARN]' : '[INFO]';
      const suffix = data !== undefined ? ' ' + JSON.stringify(data) : '';
      console.log(`${tag} ${message}${suffix}`);
    }
  }

  section(title: string): void {
    const ev: LogEvent = {
      ts: Date.now(),
      source: 'info',
      level: 'info',
      message: `── ${title} ──`,
    };
    bus.emit('log', ev);
    void writeToFile(ev);

    if (isPlainMode()) {
      console.log(`\n${'='.repeat(70)}\n  ${title}\n${'='.repeat(70)}\n`);
    }
  }

  debug(message: string, data?: unknown): void {
    this.emit('debug', message, data);
  }

  info(message: string, data?: unknown): void {
    this.emit('info', message, data);
  }

  warn(message: string, data?: unknown): void {
    this.emit('warn', message, data);
  }

  error(message: string, err: unknown): void {
    const detail = err instanceof Error ? err.message : String(err);
    this.emit('error', `${message}: ${detail}`);
  }
}

const logLevel = (process.env.LOG_LEVEL || 'info') as LogLevel;
export const logger = new Logger(logLevel);
