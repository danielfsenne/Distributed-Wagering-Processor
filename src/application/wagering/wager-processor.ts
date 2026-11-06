import {
  WagerTransactionFailed,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../domain/messaging/events';
import type { EventContext, IntegrationEvent } from '../../domain/messaging/integration-event';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { ReferenceRetryPolicy } from '../../domain/wagering/reference-retry-policy';
import { WagerSettlement } from '../../domain/wagering/wager-settlement';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction';
import { isReversalKind } from '../../domain/wagering/wager-transaction-kind';
import { WagerTransactionStatus } from '../../domain/wagering/wager-transaction-status';
import type { Wallet } from '../../domain/wallet/wallet';
import type { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import type { TransactionScope } from '../ports';

export type PersistMode =
  | { kind: 'insert' }
  | { kind: 'update'; expected: { status: WagerTransactionStatus; referenceAttempts: number } };

export class WagerProcessor {
  constructor(private readonly retryPolicy: ReferenceRetryPolicy = ReferenceRetryPolicy.DEFAULT) {}

  async settle(
    scope: TransactionScope,
    transaction: WagerTransaction,
    wallet: Wallet,
    mode: PersistMode,
    context: EventContext,
  ): Promise<WalletLedgerEntry | undefined> {
    const reference = transaction.referenceExternalTransactionId
      ? await scope.transactions.findByProviderExternalId(
          transaction.providerId,
          transaction.referenceExternalTransactionId,
        )
      : undefined;
    const referenceAlreadyReversed =
      reference && isReversalKind(transaction.kind)
        ? await scope.transactions.hasProcessedReversal(reference.id)
        : false;
    const versionBefore = wallet.version;

    const { entry } = WagerSettlement.settle({
      transaction,
      wallet,
      reference,
      referenceAlreadyReversed,
      retryPolicy: this.retryPolicy,
      at: context.occurredAt,
    });

    if (mode.kind === 'insert') {
      await scope.transactions.insert(transaction);
    } else {
      await scope.transactions.update(transaction, mode.expected);
    }
    if (entry) {
      await scope.ledger.append(entry);
      await scope.wallets.saveBalance(wallet, versionBefore);
    }
    await scope.outbox.enqueue(this.eventsFor(transaction, wallet, entry, context).map(OutboxMessage.enqueue));
    if (transaction.isTerminal()) {
      await scope.transactions.wakePendingDependents(
        transaction.providerId,
        transaction.externalTransactionId,
        context.occurredAt,
      );
    }
    return entry;
  }

  async fail(
    scope: TransactionScope,
    transaction: WagerTransaction,
    code: Parameters<WagerTransaction['fail']>[0],
    context: EventContext,
  ): Promise<void> {
    const expected = { status: transaction.status, referenceAttempts: transaction.referenceAttempts };
    transaction.fail(code, context.occurredAt);
    await scope.transactions.update(transaction, expected);
    await scope.outbox.enqueue([OutboxMessage.enqueue(WagerTransactionFailed.from(transaction, context))]);
  }

  private eventsFor(
    transaction: WagerTransaction,
    wallet: Wallet,
    entry: WalletLedgerEntry | undefined,
    context: EventContext,
  ): IntegrationEvent<unknown>[] {
    switch (transaction.status) {
      case WagerTransactionStatus.Processed:
        return entry
          ? [
              WagerTransactionProcessed.from(transaction, context),
              WalletBalanceChanged.from(wallet, entry, context),
            ]
          : [WagerTransactionProcessed.from(transaction, context)];
      case WagerTransactionStatus.Rejected:
        return [WagerTransactionRejected.from(transaction, context)];
      case WagerTransactionStatus.PendingReference:
        return transaction.referenceAttempts === 1
          ? [WagerTransactionPendingReference.from(transaction, context)]
          : [];
      default:
        return [];
    }
  }
}
