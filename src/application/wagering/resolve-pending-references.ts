import { newId } from '../../domain/shared/id';
import { FailureCode } from '../../domain/wagering/failure-code';
import { WagerTransactionStatus } from '../../domain/wagering/wager-transaction-status';
import type { Clock, Logger, Metrics, TransactionScope, UnitOfWork } from '../ports';
import { isConcurrencyRetryable, withTransactionRetry } from '../transaction-retry';
import { TransientError } from '../errors';
import type { WagerProcessor } from './wager-processor';

export interface ResolvePendingReferencesOptions {
  batchSize: number;
  leaseMs: number;
}

export interface ResolutionSummary {
  claimed: number;
  resolved: number;
  stillPending: number;
  failed: number;
}

export class ResolvePendingReferences {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly processor: WagerProcessor,
    private readonly clock: Clock,
    private readonly metrics: Metrics,
    private readonly logger: Logger,
    private readonly options: ResolvePendingReferencesOptions = { batchSize: 50, leaseMs: 30_000 },
  ) {}

  async runOnce(): Promise<ResolutionSummary> {
    const ids = await this.unitOfWork.run((scope) =>
      scope.transactions.claimDuePendingReferences(
        this.clock.now(),
        this.options.batchSize,
        this.options.leaseMs,
      ),
    );
    const summary: ResolutionSummary = { claimed: ids.length, resolved: 0, stillPending: 0, failed: 0 };
    for (const id of ids) {
      const status = await this.resolve(id);
      if (status === WagerTransactionStatus.PendingReference) {
        summary.stillPending++;
      } else if (status === WagerTransactionStatus.Failed) {
        summary.failed++;
      } else if (status) {
        summary.resolved++;
      }
    }
    if (ids.length > 0) {
      this.logger.info('pending references processed', { ...summary });
    }
    return summary;
  }

  private async resolve(transactionId: string): Promise<WagerTransactionStatus | undefined> {
    try {
      return await withTransactionRetry(
        () => this.unitOfWork.run((scope) => this.attempt(scope, transactionId)),
        { component: 'reference-worker', metrics: this.metrics },
      );
    } catch (error) {
      if (error instanceof TransientError || isConcurrencyRetryable(error)) {
        this.logger.warn('pending reference resolution deferred', {
          transactionId,
          error: (error as Error).message,
        });
        return undefined;
      }
      this.logger.error('pending reference resolution failed permanently', {
        transactionId,
        error: (error as Error).message,
      });
      return this.markFailed(transactionId);
    }
  }

  private async attempt(
    scope: TransactionScope,
    transactionId: string,
  ): Promise<WagerTransactionStatus | undefined> {
    const candidate = await scope.transactions.findById(transactionId);
    if (!candidate || candidate.status !== WagerTransactionStatus.PendingReference) {
      return undefined;
    }
    const wallet = await scope.wallets.lockById(candidate.walletId);
    const transaction = await scope.transactions.findById(transactionId);
    if (!wallet || !transaction || transaction.status !== WagerTransactionStatus.PendingReference) {
      return undefined;
    }
    const expected = { status: transaction.status, referenceAttempts: transaction.referenceAttempts };
    const now = this.clock.now();
    await this.processor.settle(scope, transaction, wallet, { kind: 'update', expected }, {
      correlationId: newId(),
      causationId: transaction.id,
      occurredAt: now,
    });
    if (transaction.isTerminal()) {
      this.metrics.transactionSettled(transaction.status, transaction.kind, 'reference-worker');
    }
    this.logger.info('pending reference attempt', {
      transactionId,
      walletId: transaction.walletId,
      providerId: transaction.providerId,
      status: transaction.status,
      failureCode: transaction.failureCode,
      attempts: transaction.referenceAttempts,
    });
    return transaction.status;
  }

  private async markFailed(transactionId: string): Promise<WagerTransactionStatus | undefined> {
    try {
      return await this.unitOfWork.run(async (scope) => {
        const candidate = await scope.transactions.findById(transactionId);
        if (!candidate) return undefined;
        await scope.wallets.lockById(candidate.walletId);
        const transaction = await scope.transactions.findById(transactionId);
        if (!transaction || transaction.isTerminal()) return transaction?.status;
        await this.processor.fail(scope, transaction, FailureCode.ProcessingError, {
          correlationId: newId(),
          causationId: transaction.id,
          occurredAt: this.clock.now(),
        });
        this.metrics.transactionSettled(transaction.status, transaction.kind, 'reference-worker');
        return transaction.status;
      });
    } catch (error) {
      this.logger.error('could not mark transaction as failed', {
        transactionId,
        error: (error as Error).message,
      });
      return undefined;
    }
  }
}
