import type { MoneyProps } from '../shared/money';
import { FailureCode } from '../wagering/failure-code';
import type { WagerTransaction } from '../wagering/wager-transaction';
import { WagerTransactionKind } from '../wagering/wager-transaction-kind';
import { LedgerDirection } from '../wallet/ledger-direction';
import type { Wallet } from '../wallet/wallet';
import type { WalletLedgerEntry } from '../wallet/wallet-ledger-entry';
import { type EventContext, IntegrationEvent } from './integration-event';

interface TransactionEventData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
}

export interface WagerTransactionProcessedData extends TransactionEventData {
  referenceTransactionId: string | null;
  balance: MoneyProps;
  processedAt: string;
}

export interface WagerTransactionRejectedData extends TransactionEventData {
  failureCode: FailureCode;
  balance: MoneyProps;
  rejectedAt: string;
}

export interface WagerTransactionPendingReferenceData extends TransactionEventData {
  referenceExternalTransactionId: string;
  attempts: number;
  nextAttemptAt: string | null;
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

function transactionData(transaction: WagerTransaction): TransactionEventData {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
  };
}

function requireResultBalance(transaction: WagerTransaction): MoneyProps {
  if (!transaction.resultBalance) {
    throw new Error(`Transaction ${transaction.id} has no result balance`);
  }
  return transaction.resultBalance.toJSON();
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed(
      IntegrationEvent.propsFrom(
        transaction.id,
        {
          ...transactionData(transaction),
          referenceTransactionId: transaction.referenceTransactionId ?? null,
          balance: requireResultBalance(transaction),
          processedAt: (transaction.processedAt ?? context.occurredAt).toISOString(),
        },
        context,
      ),
    );
  }
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionRejected {
    if (!transaction.failureCode) {
      throw new Error(`Transaction ${transaction.id} has no failure code`);
    }
    return new WagerTransactionRejected(
      IntegrationEvent.propsFrom(
        transaction.id,
        {
          ...transactionData(transaction),
          failureCode: transaction.failureCode,
          balance: requireResultBalance(transaction),
          rejectedAt: (transaction.processedAt ?? context.occurredAt).toISOString(),
        },
        context,
      ),
    );
  }
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference(
      IntegrationEvent.propsFrom(
        transaction.id,
        {
          ...transactionData(transaction),
          referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? '',
          attempts: transaction.referenceAttempts,
          nextAttemptAt: transaction.nextReferenceAttemptAt?.toISOString() ?? null,
        },
        context,
      ),
    );
  }
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, context: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged(
      IntegrationEvent.propsFrom(
        wallet.id,
        {
          walletId: wallet.id,
          transactionId: entry.transactionId,
          direction: entry.direction,
          money: entry.money.toJSON(),
          balanceBefore: entry.balanceBefore.toJSON(),
          balanceAfter: entry.balanceAfter.toJSON(),
          walletVersion: entry.walletVersion,
        },
        context,
      ),
    );
  }
}
