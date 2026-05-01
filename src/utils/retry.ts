import { logger } from './logger.js';

interface RetryOptions {
  maxAttempts?: number;
  initialDelay?: number;
  maxDelay?: number;
  backoffMultiplier?: number;
}

const isRetryable = (err: any): boolean => {
  if (!(err instanceof Error)) return false;

  const message = err.message.toLowerCase();
  const retryableErrors = [
    'rate_limit',
    'timeout',
    'econnrefused',
    'econnreset',
    'etimedout',
  ];

  return retryableErrors.some((e) => message.includes(e));
};

export async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxAttempts = 3,
    initialDelay = 1000,
    maxDelay = 32000,
    backoffMultiplier = 2,
  } = options;

  let lastErr: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));

      if (!isRetryable(err) || attempt === maxAttempts) {
        throw err;
      }

      const delay = Math.min(
        initialDelay * Math.pow(backoffMultiplier, attempt - 1) +
          Math.random() * 1000,
        maxDelay
      );

      logger.warn(
        `${label} failed (attempt ${attempt}/${maxAttempts}), retrying in ${Math.round(delay)}ms`,
        lastErr.message
      );

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastErr;
}
