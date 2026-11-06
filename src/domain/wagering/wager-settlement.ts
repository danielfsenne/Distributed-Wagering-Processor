import { Wallet } from '../wallet/wallet';
import { LedgerDirection } from '../wallet/ledger-direction';
import { WalletLedgerEntry } from '../wallet/wallet-ledger-entry';
import { FailureCode } from './failure-code';
import { ReferenceRetryPolicy } from './reference-retry-policy';
import { WagerTransaction } from './wager-transaction';
import { ALLOWED_REFERENCE_KINDS, WagerTransactionKind, isReversalKind } from './wager-transaction-kind';
import { WagerTransactionStatus } from './wager-transaction-status';

export interface SettlementInput {
  transaction: WagerTransaction;
  wallet: Wallet;
  reference: WagerTransaction | undefined;
  referenceAlreadyReversed: boolean;
  retryPolicy: ReferenceRetryPolicy;
  at: Date;
}

export interface SettlementResult {
  transaction: WagerTransaction;
  entry: WalletLedgerEntry | undefined;
}

export class WagerSettlement {
  static settle(input: SettlementInput): SettlementResult {
    const { transaction, wallet, at } = input;

    const precondition = WagerSettlement.checkWallet(transaction, wallet);
    if (precondition) {
      return WagerSettlement.rejected(input, precondition);
    }

    if (transaction.hasReference()) {
      const { reference } = input;
      if (!reference || WagerSettlement.isAwaiting(reference)) {
        return WagerSettlement.awaitReference(input);
      }
      const referenceFailure = WagerSettlement.checkReference(input, reference);
      if (referenceFailure) {
        return WagerSettlement.rejected(input, referenceFailure);
      }
    }

    if (!transaction.affectsBalance()) {
      transaction.markProcessed(input.reference?.id, at, wallet.balance);
      return { transaction, entry: undefined };
    }

    const direction = transaction.ledgerDirectionFor(input.reference);
    if (direction === LedgerDirection.Debit && !wallet.canDebit(transaction.money)) {
      const code =
        transaction.kind === WagerTransactionKind.Bet
          ? FailureCode.InsufficientFunds
          : FailureCode.ReversalInsufficientFunds;
      return WagerSettlement.rejected(input, code);
    }

    const entry = wallet.apply(direction, transaction.money, { transactionId: transaction.id, at });
    transaction.markProcessed(input.reference?.id, at, wallet.balance);
    return { transaction, entry };
  }

  private static checkWallet(transaction: WagerTransaction, wallet: Wallet): FailureCode | undefined {
    if (transaction.walletId !== wallet.id || transaction.playerId !== wallet.playerId) {
      return FailureCode.PlayerWalletMismatch;
    }
    if (transaction.money.currency !== wallet.currency) {
      return FailureCode.CurrencyMismatch;
    }
    return undefined;
  }

  private static checkReference(
    input: SettlementInput,
    reference: WagerTransaction,
  ): FailureCode | undefined {
    const { transaction } = input;
    if (reference.status !== WagerTransactionStatus.Processed) {
      return FailureCode.ReferenceNotProcessed;
    }
    const allowed = ALLOWED_REFERENCE_KINDS[transaction.kind] ?? [];
    if (!allowed.includes(reference.kind)) {
      return FailureCode.ReferenceKindNotAllowed;
    }
    const sameContext =
      reference.providerId === transaction.providerId &&
      reference.playerId === transaction.playerId &&
      reference.walletId === transaction.walletId &&
      reference.roundId === transaction.roundId &&
      reference.money.currency === transaction.money.currency;
    if (!sameContext) {
      return FailureCode.ReferenceMismatch;
    }
    if (isReversalKind(transaction.kind)) {
      if (!reference.money.equals(transaction.money)) {
        return FailureCode.ReferenceAmountMismatch;
      }
      if (input.referenceAlreadyReversed) {
        return FailureCode.AlreadyReversed;
      }
    }
    return undefined;
  }

  private static isAwaiting(reference: WagerTransaction): boolean {
    return (
      reference.status === WagerTransactionStatus.Pending ||
      reference.status === WagerTransactionStatus.PendingReference
    );
  }

  private static awaitReference(input: SettlementInput): SettlementResult {
    const { transaction, retryPolicy, at } = input;
    const attemptsMade = transaction.referenceAttempts + 1;
    if (retryPolicy.isExhausted(attemptsMade)) {
      return WagerSettlement.rejected(input, FailureCode.ReferenceNotFound);
    }
    transaction.markPendingReference(retryPolicy.nextAttemptAt(attemptsMade, at), at);
    return { transaction, entry: undefined };
  }

  private static rejected(input: SettlementInput, code: FailureCode): SettlementResult {
    input.transaction.reject(code, input.at, input.wallet.balance);
    return { transaction: input.transaction, entry: undefined };
  }
}
