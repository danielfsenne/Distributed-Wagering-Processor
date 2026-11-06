import { ConcurrencyConflictError, TransientError, UniqueViolationError } from '../../application/errors';

interface PgLikeError {
  code?: string;
  constraint?: string;
  message?: string;
}

const TRANSIENT_NODE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
]);

const TRANSIENT_SQLSTATES = new Set(['53300', '57P01', '57P02', '57P03', '57014', '58000', '58030']);

export function translateDatabaseError(error: unknown): unknown {
  if (
    error instanceof ConcurrencyConflictError ||
    error instanceof UniqueViolationError ||
    error instanceof TransientError
  ) {
    return error;
  }
  const pg = (error ?? {}) as PgLikeError;
  const code = pg.code ?? '';
  const message = pg.message ?? String(error);

  switch (code) {
    case '23505':
      return new UniqueViolationError(pg.constraint, { cause: error });
    case '40P01':
      return new ConcurrencyConflictError('deadlock', message, { cause: error });
    case '40001':
      return new ConcurrencyConflictError('serialization', message, { cause: error });
    case '55P03':
      return new ConcurrencyConflictError('lock_timeout', message, { cause: error });
  }
  if (code.startsWith('08') || TRANSIENT_SQLSTATES.has(code) || TRANSIENT_NODE_CODES.has(code)) {
    return new TransientError(`database unavailable: ${message}`, error);
  }
  if (/Connection terminated|connect ECONNREFUSED|timeout exceeded when trying to connect|Client has encountered a connection error/i.test(message)) {
    return new TransientError(`database unavailable: ${message}`, error);
  }
  return error;
}
