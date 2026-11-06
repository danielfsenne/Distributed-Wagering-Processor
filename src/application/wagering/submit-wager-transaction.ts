import { InboxMessage } from '../../domain/messaging/inbox-message';
import type { EventContext } from '../../domain/messaging/integration-event';
import { WagerTransaction } from '../../domain/wagering/wager-transaction';
import {
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  NotFoundError,
} from '../errors';
import type { Clock, Logger, Metrics, TransactionScope, TransactionSource, UnitOfWork } from '../ports';
import { withTransactionRetry } from '../transaction-retry';
import { toOutcome, type WagerOutcome } from './wager-outcome';
import { type WagerPayload, wagerPayloadHash } from './wager-payload';
import type { WagerProcessor } from './wager-processor';

export interface InboxContext {
  consumerName: string;
  messageId: string;
  messageHash: string;
}

export interface SubmitWagerCommand {
  idempotencyKey: string;
  payload: WagerPayload;
  correlationId: string;
  causationId?: string | undefined;
  source: TransactionSource;
  inbox?: InboxContext | undefined;
}

export class SubmitWagerTransaction {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly processor: WagerProcessor,
    private readonly clock: Clock,
    private readonly metrics: Metrics,
    private readonly logger: Logger,
  ) {}

  async execute(command: SubmitWagerCommand): Promise<WagerOutcome> {
    const startedAt = performance.now();
    const hash = wagerPayloadHash(command.payload);
    const outcome = await withTransactionRetry(
      () => this.unitOfWork.run((scope) => this.process(scope, command, hash)),
      { component: 'submit-wager', metrics: this.metrics },
    );
    const seconds = (performance.now() - startedAt) / 1000;
    this.metrics.processingDuration(command.source, seconds);
    if (outcome.idempotentReplay) {
      this.metrics.duplicateDetected(command.source);
    } else {
      this.metrics.transactionSettled(outcome.status, command.payload.kind, command.source);
    }
    this.logger.info('wager transaction handled', {
      transactionId: outcome.transactionId,
      walletId: command.payload.walletId,
      providerId: command.payload.providerId,
      kind: command.payload.kind,
      status: outcome.status,
      failureCode: outcome.failureCode,
      idempotentReplay: outcome.idempotentReplay,
      durationMs: Math.round(seconds * 1000),
    });
    return outcome;
  }

  private async process(
    scope: TransactionScope,
    command: SubmitWagerCommand,
    hash: string,
  ): Promise<WagerOutcome> {
    const { payload, idempotencyKey } = command;
    const now = this.clock.now();

    const inboxMessage = command.inbox
      ? InboxMessage.receive({
          messageId: command.inbox.messageId,
          consumerName: command.inbox.consumerName,
          payloadHash: command.inbox.messageHash,
          at: now,
        })
      : undefined;
    if (inboxMessage && !(await scope.inbox.tryReceive(inboxMessage))) {
      this.metrics.duplicateDetected('inbox');
      const previous = await scope.transactions.findByIdempotencyKey(idempotencyKey);
      if (previous) {
        return this.replay(scope, previous, hash);
      }
    }

    const wallet = await scope.wallets.lockById(payload.walletId);
    if (!wallet) {
      throw NotFoundError.wallet(payload.walletId);
    }

    const existing = await scope.transactions.findByIdempotencyKey(idempotencyKey);
    if (existing) {
      return this.replay(scope, existing, hash, wallet);
    }
    const sameExternal = await scope.transactions.findByProviderExternalId(
      payload.providerId,
      payload.externalTransactionId,
    );
    if (sameExternal) {
      throw new ExternalTransactionConflictError(
        payload.providerId,
        payload.externalTransactionId,
        sameExternal.id,
      );
    }

    const transaction = WagerTransaction.create({
      providerId: payload.providerId,
      externalTransactionId: payload.externalTransactionId,
      idempotencyKey,
      payloadHash: hash,
      walletId: payload.walletId,
      playerId: payload.playerId,
      roundId: payload.roundId,
      gameId: payload.gameId,
      kind: payload.kind,
      money: payload.money,
      referenceExternalTransactionId: payload.referenceExternalTransactionId,
      at: now,
    });
    const context: EventContext = {
      correlationId: command.correlationId,
      causationId: command.causationId,
      occurredAt: now,
    };
    await this.processor.settle(scope, transaction, wallet, { kind: 'insert' }, context);
    if (inboxMessage) {
      inboxMessage.markProcessed(now);
      await scope.inbox.markProcessed(inboxMessage, transaction.id);
    }
    return toOutcome(transaction, wallet, false);
  }

  private async replay(
    scope: TransactionScope,
    existing: WagerTransaction,
    hash: string,
    lockedWallet?: Awaited<ReturnType<TransactionScope['wallets']['findById']>>,
  ): Promise<WagerOutcome> {
    if (!existing.matchesPayload(hash)) {
      throw new IdempotencyConflictError(existing.idempotencyKey, existing.id);
    }
    const wallet = existing.resultBalance
      ? undefined
      : (lockedWallet ?? (await scope.wallets.findById(existing.walletId)));
    return toOutcome(existing, wallet, true);
  }
}
