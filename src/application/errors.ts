export type ErrorCategory = 'validation' | 'conflict' | 'not-found' | 'transient';

export interface ValidationIssue {
  field: string;
  message: string;
}

export abstract class ApplicationError extends Error {
  abstract readonly code: string;
  abstract readonly category: ErrorCategory;

  protected constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ValidationError extends ApplicationError {
  readonly category = 'validation';

  constructor(
    readonly code: string,
    message: string,
    readonly issues: ValidationIssue[] = [],
  ) {
    super(message);
  }

  static invalidPayload(issues: ValidationIssue[]): ValidationError {
    return new ValidationError('INVALID_PAYLOAD', 'The payload is invalid', issues);
  }
}

export class IdempotencyConflictError extends ApplicationError {
  readonly code = 'IDEMPOTENCY_KEY_CONFLICT';
  readonly category = 'conflict';

  constructor(
    readonly idempotencyKey: string,
    readonly transactionId: string,
  ) {
    super(`Idempotency key ${idempotencyKey} was already used with a different payload`);
  }
}

export class ExternalTransactionConflictError extends ApplicationError {
  readonly code = 'EXTERNAL_TRANSACTION_CONFLICT';
  readonly category = 'conflict';

  constructor(
    readonly providerId: string,
    readonly externalTransactionId: string,
    readonly transactionId: string,
  ) {
    super(
      `Transaction ${providerId}/${externalTransactionId} was already submitted under another idempotency key`,
    );
  }
}

export class MessageIdConflictError extends ApplicationError {
  readonly code = 'MESSAGE_ID_CONFLICT';
  readonly category = 'conflict';

  constructor(
    readonly consumerName: string,
    readonly messageId: string,
  ) {
    super(`Message ${messageId} was already consumed by ${consumerName} for another transaction`);
  }
}

export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = 'WALLET_ALREADY_EXISTS';
  readonly category = 'conflict';

  constructor(playerId: string, currency: string) {
    super(`Player ${playerId} already has a ${currency} wallet`);
  }
}

export class NotFoundError extends ApplicationError {
  readonly category = 'not-found';

  constructor(
    readonly code: 'WALLET_NOT_FOUND' | 'TRANSACTION_NOT_FOUND',
    message: string,
  ) {
    super(message);
  }

  static wallet(walletId: string): NotFoundError {
    return new NotFoundError('WALLET_NOT_FOUND', `Wallet ${walletId} not found`);
  }

  static transaction(description: string): NotFoundError {
    return new NotFoundError('TRANSACTION_NOT_FOUND', `Transaction ${description} not found`);
  }
}

export class TransientError extends ApplicationError {
  readonly code = 'TRANSIENT_FAILURE';
  readonly category = 'transient';

  constructor(message: string, cause?: unknown) {
    super(message, { cause });
  }
}

export class ConcurrencyConflictError extends Error {
  constructor(
    readonly reason: 'lock_timeout' | 'deadlock' | 'serialization' | 'version_mismatch' | 'status_changed',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ConcurrencyConflictError';
  }
}

export class UniqueViolationError extends Error {
  constructor(
    readonly constraint: string | undefined,
    options?: { cause?: unknown },
  ) {
    super(`Unique constraint violated: ${constraint ?? 'unknown'}`, options);
    this.name = 'UniqueViolationError';
  }
}
