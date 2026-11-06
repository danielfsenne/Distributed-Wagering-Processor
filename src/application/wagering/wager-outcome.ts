import type { MoneyProps } from '../../domain/shared/money';
import type { FailureCode } from '../../domain/wagering/failure-code';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction';
import type { WagerTransactionStatus } from '../../domain/wagering/wager-transaction-status';
import type { Wallet } from '../../domain/wallet/wallet';

export interface WagerOutcome {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}

export function toOutcome(
  transaction: WagerTransaction,
  wallet: Wallet | undefined,
  idempotentReplay: boolean,
): WagerOutcome {
  const balance = transaction.resultBalance ?? wallet?.balance;
  if (!balance) {
    throw new Error(`No balance available for transaction ${transaction.id}`);
  }
  return {
    transactionId: transaction.id,
    status: transaction.status,
    balance: balance.toJSON(),
    ...(transaction.failureCode ? { failureCode: transaction.failureCode } : {}),
    idempotentReplay,
  };
}
