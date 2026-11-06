import { DomainError } from '../../domain/shared/domain-error';
import { Money, type MoneyProps } from '../../domain/shared/money';
import { EXTERNAL_KINDS, WagerTransactionKind } from '../../domain/wagering/wager-transaction-kind';
import { ValidationError, type ValidationIssue } from '../errors';
import { payloadHash } from '../idempotency/payload-hash';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDENTIFIER_PATTERN = /^[\x21-\x7e]+$/;
const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

export interface WagerPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId: string | undefined;
}

export interface HashableWagerPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

export function hashableView(payload: WagerPayload): HashableWagerPayload {
  return {
    providerId: payload.providerId,
    externalTransactionId: payload.externalTransactionId,
    playerId: payload.playerId.toLowerCase(),
    walletId: payload.walletId.toLowerCase(),
    roundId: payload.roundId,
    gameId: payload.gameId,
    kind: payload.kind,
    money: payload.money.toJSON(),
    ...(payload.referenceExternalTransactionId
      ? { referenceExternalTransactionId: payload.referenceExternalTransactionId }
      : {}),
  };
}

export function wagerPayloadHash(payload: WagerPayload): string {
  return payloadHash(hashableView(payload));
}

export function parseIdempotencyKey(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ValidationError('MISSING_IDEMPOTENCY_KEY', 'Idempotency-Key is required');
  }
  if (raw.length > MAX_IDEMPOTENCY_KEY_LENGTH || !IDENTIFIER_PATTERN.test(raw)) {
    throw new ValidationError(
      'INVALID_IDEMPOTENCY_KEY',
      `Idempotency-Key must be 1-${MAX_IDEMPOTENCY_KEY_LENGTH} printable ASCII characters without spaces`,
    );
  }
  return raw;
}

export function parseWagerPayload(raw: unknown): WagerPayload {
  const issues: ValidationIssue[] = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw ValidationError.invalidPayload([{ field: '$', message: 'must be a JSON object' }]);
  }
  const body = raw as Record<string, unknown>;

  const identifier = (field: string, maxLength: number): string => {
    const value = body[field];
    if (typeof value !== 'string' || value.length === 0) {
      issues.push({ field, message: 'is required' });
      return '';
    }
    if (value.length > maxLength || !IDENTIFIER_PATTERN.test(value)) {
      issues.push({ field, message: `must be 1-${maxLength} printable ASCII characters without spaces` });
    }
    return value;
  };

  const uuid = (field: string): string => {
    const value = body[field];
    if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
      issues.push({ field, message: 'must be a UUID' });
      return '';
    }
    return value.toLowerCase();
  };

  const providerId = identifier('providerId', 100);
  const externalTransactionId = identifier('externalTransactionId', 200);
  const playerId = uuid('playerId');
  const walletId = uuid('walletId');
  const roundId = identifier('roundId', 200);
  const gameId = identifier('gameId', 200);

  let kind = WagerTransactionKind.Bet;
  if (!EXTERNAL_KINDS.includes(body.kind as WagerTransactionKind)) {
    issues.push({ field: 'kind', message: `must be one of ${EXTERNAL_KINDS.join(', ')}` });
  } else {
    kind = body.kind as WagerTransactionKind;
  }

  let money: Money | undefined;
  try {
    money = Money.from(body.money as MoneyProps);
  } catch (error) {
    issues.push({
      field: 'money',
      message: error instanceof DomainError ? error.message : 'must be { amount, currency }',
    });
  }

  let referenceExternalTransactionId: string | undefined;
  if (body.referenceExternalTransactionId !== undefined && body.referenceExternalTransactionId !== null) {
    referenceExternalTransactionId = identifier('referenceExternalTransactionId', 200);
  }
  if ((kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback) && !referenceExternalTransactionId) {
    issues.push({ field: 'referenceExternalTransactionId', message: `is required for ${kind}` });
  }
  if (referenceExternalTransactionId && referenceExternalTransactionId === externalTransactionId) {
    issues.push({ field: 'referenceExternalTransactionId', message: 'cannot reference itself' });
  }
  if (money && kind !== WagerTransactionKind.Loss && money.isZero()) {
    issues.push({ field: 'money', message: `amount must be positive for ${kind}` });
  }

  if (issues.length > 0 || !money) {
    throw ValidationError.invalidPayload(issues);
  }

  return {
    providerId,
    externalTransactionId,
    playerId,
    walletId,
    roundId,
    gameId,
    kind,
    money,
    referenceExternalTransactionId,
  };
}
