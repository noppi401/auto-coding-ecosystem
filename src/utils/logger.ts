type LogLevel = 'debug' | 'info' | 'warn' | 'error';

class Logger {
  private logLevel: LogLevel;

  constructor(level: LogLevel = 'info') {
    this.logLevel = level;
  }

  private shouldLog(level: LogLevel): boolean {
    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    return levels.indexOf(level) >= levels.indexOf(this.logLevel);
  }

  section(title: string): void {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`  ${title}`);
    console.log(`${'='.repeat(70)}\n`);
  }

  debug(message: string, data?: any): void {
    if (this.shouldLog('debug')) {
      console.log(`[DEBUG] ${message}`, data ? JSON.stringify(data) : '');
    }
  }

  info(message: string, data?: any): void {
    if (this.shouldLog('info')) {
      console.log(`[INFO] ${message}`, data ? JSON.stringify(data) : '');
    }
  }

  warn(message: string, data?: any): void {
    if (this.shouldLog('warn')) {
      console.log(`[WARN] ${message}`, data ? JSON.stringify(data) : '');
    }
  }

  error(message: string, err: any): void {
    if (this.shouldLog('error')) {
      const errMsg =
        err instanceof Error ? err.message : JSON.stringify(err);
      console.log(`[ERROR] ${message}: ${errMsg}`);
    }
  }
}

const logLevel = (process.env.LOG_LEVEL || 'info') as LogLevel;
export const logger = new Logger(logLevel);
