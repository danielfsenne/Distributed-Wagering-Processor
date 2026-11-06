import { newId } from '../../src/domain/shared/id';
import { Money } from '../../src/domain/shared/money';
import { ReferenceRetryPolicy } from '../../src/domain/wagering/reference-retry-policy';
import { WagerTransaction } from '../../src/domain/wagering/wager-transaction';
import { WagerTransactionKind } from '../../src/domain/wagering/wager-transaction-kind';
import { Wallet } from '../../src/domain/wallet/wallet';

export const NOW = new Date('2026-07-29T15:00:00.000Z');
export const PLAYER_ID = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';

export const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
export const usd = (amount: string) => Money.from({ amount, currency: 'USD' });

export const retryPolicy = ReferenceRetryPolicy.of({
  maxAttempts: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 10_000,
});

export function openWallet(balance = '100.00', currency = 'BRL'): Wallet {
  return Wallet.open({
    id: newId(),
    playerId: PLAYER_ID,
    initialBalance: Money.from({ amount: balance, currency }),
    openingTransactionId: newId(),
    at: NOW,
  }).wallet;
}

let sequence = 0;

export function tx(
  wallet: Wallet,
  kind: WagerTransactionKind,
  amount: string,
  overrides: Partial<{
    externalTransactionId: string;
    reference: string;
    roundId: string;
    playerId: string;
    providerId: string;
    money: Money;
  }> = {},
): WagerTransaction {
  const externalTransactionId = overrides.externalTransactionId ?? `ext-${++sequence}`;
  const providerId = overrides.providerId ?? 'provider-a';
  return WagerTransaction.create({
    providerId,
    externalTransactionId,
    idempotencyKey: `${providerId}:${externalTransactionId}`,
    payloadHash: 'hash',
    walletId: wallet.id,
    playerId: overrides.playerId ?? wallet.playerId,
    roundId: overrides.roundId ?? 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: overrides.money ?? Money.from({ amount, currency: wallet.currency }),
    referenceExternalTransactionId: overrides.reference,
    at: NOW,
  });
}
