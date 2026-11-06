import { ConcurrencyConflictError, TransientError, UniqueViolationError } from './errors';
import type { Metrics } from './ports';

export interface RetryOptions {
  component: string;
  metrics: Metrics;
  maxAttempts?: number;
  baseDelayMs?: number;
  isRetryable?: (error: unknown) => boolean;
}

export function isConcurrencyRetryable(error: unknown): boolean {
  return error instanceof ConcurrencyConflictError || error instanceof UniqueViolationError;
}

export async function withTransactionRetry<T>(
  work: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 5;
  const baseDelayMs = options.baseDelayMs ?? 10;
  const isRetryable = options.isRetryable ?? isConcurrencyRetryable;

  for (let attempt = 1; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      if (!isRetryable(error)) {
        throw error;
      }
      const reason =
        error instanceof ConcurrencyConflictError
          ? error.reason
          : error instanceof UniqueViolationError
            ? `unique:${error.constraint ?? 'unknown'}`
            : 'unknown';
      if (error instanceof ConcurrencyConflictError) {
        options.metrics.lockConflict(error.reason);
      }
      if (attempt >= maxAttempts) {
        throw new TransientError(
          `${options.component} gave up after ${attempt} attempts (${reason})`,
          error,
        );
      }
      options.metrics.retry(options.component, reason);
      const jitter = Math.random() * baseDelayMs;
      await Bun.sleep(baseDelayMs * 2 ** (attempt - 1) + jitter);
    }
  }
}
