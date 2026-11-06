import { ValidationError } from '../../application/errors';
import { parseIdempotencyKey, parseWagerPayload, type WagerPayload } from '../../application/wagering/wager-payload';

export const WAGER_MESSAGE_TYPE = 'WagerTransactionRequested';

export interface WagerMessage {
  messageId: string;
  type: typeof WAGER_MESSAGE_TYPE;
  occurredAt: string;
  correlationId: string | undefined;
  idempotencyKey: string;
  payload: WagerPayload;
}

export function parseWagerMessage(body: string): WagerMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw ValidationError.invalidPayload([{ field: '$', message: 'message body is not valid JSON' }]);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw ValidationError.invalidPayload([{ field: '$', message: 'message body must be an object' }]);
  }
  const envelope = parsed as Record<string, unknown>;
  if (typeof envelope.messageId !== 'string' || envelope.messageId.length === 0 || envelope.messageId.length > 200) {
    throw ValidationError.invalidPayload([{ field: 'messageId', message: 'is required (max 200 chars)' }]);
  }
  if (envelope.type !== WAGER_MESSAGE_TYPE) {
    throw ValidationError.invalidPayload([{ field: 'type', message: `must be ${WAGER_MESSAGE_TYPE}` }]);
  }
  const data = envelope.data;
  if (typeof data !== 'object' || data === null) {
    throw ValidationError.invalidPayload([{ field: 'data', message: 'is required' }]);
  }
  const record = data as Record<string, unknown>;
  return {
    messageId: envelope.messageId,
    type: WAGER_MESSAGE_TYPE,
    occurredAt: typeof envelope.occurredAt === 'string' ? envelope.occurredAt : new Date().toISOString(),
    correlationId: typeof envelope.correlationId === 'string' ? envelope.correlationId : undefined,
    idempotencyKey: parseIdempotencyKey(record.idempotencyKey),
    payload: parseWagerPayload(record),
  };
}
