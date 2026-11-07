import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Redirect,
  Req,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { ValidationError } from '../../application/errors';
import type { WagerOutcome } from '../../application/wagering/wager-outcome';
import { parseIdempotencyKey, parseWagerPayload } from '../../application/wagering/wager-payload';
import { parseOpenWalletBody } from '../../application/wallets/open-wallet';
import { parseLimit } from '../../application/wallets/wallet-queries';
import { WagerTransactionStatus } from '../../domain/wagering/wager-transaction-status';
import type { Container } from '../../container';
import { currentLogContext, enrichLogContext } from '../../infrastructure/observability/log-context';
import { assertMayActFor } from '../../application/provider-access';
import { type AuthenticatedRequest, Public, principalOf } from './auth';
import { CONTAINER } from './tokens';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidParam(name: string, value: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw ValidationError.invalidPayload([{ field: name, message: 'must be a UUID' }]);
  }
  return value.toLowerCase();
}

function correlationId(): string {
  return String(currentLogContext().correlationId ?? '');
}

export function statusForOutcome(outcome: WagerOutcome): number {
  switch (outcome.status) {
    case WagerTransactionStatus.Processed:
      return outcome.idempotentReplay ? 200 : 201;
    case WagerTransactionStatus.Pending:
    case WagerTransactionStatus.PendingReference:
      return 202;
    case WagerTransactionStatus.Rejected:
    case WagerTransactionStatus.Failed:
      return 422;
  }
}

@Controller('wallets')
export class WalletsController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Post()
  @HttpCode(201)
  async open(@Body() body: unknown) {
    const command = parseOpenWalletBody(body);
    return this.container.openWallet.execute({ ...command, correlationId: correlationId() });
  }

  @Get(':walletId')
  async get(@Param('walletId') walletId: string) {
    return this.container.queries.getWallet(uuidParam('walletId', walletId));
  }

  @Get(':walletId/ledger')
  async ledger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
  ) {
    return this.container.queries.getLedger(uuidParam('walletId', walletId), cursor, parseLimit(limit));
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconcile(@Param('walletId') walletId: string) {
    const id = uuidParam('walletId', walletId);
    enrichLogContext({ walletId: id });
    return this.container.reconcileWallet.execute(id);
  }
}

@Controller()
export class WageringController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Post('wagering/transactions')
  async submit(
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<WagerOutcome> {
    const idempotencyKey = parseIdempotencyKey(idempotencyKeyHeader);
    const payload = parseWagerPayload(body);
    enrichLogContext({ walletId: payload.walletId, providerId: payload.providerId });

    const outcome = await this.container.submitWager.execute({
      idempotencyKey,
      payload,
      principal: principalOf(request),
      correlationId: correlationId(),
      causationId: idempotencyKey,
      source: 'http',
    });
    enrichLogContext({ transactionId: outcome.transactionId });
    response.status(statusForOutcome(outcome));
    return outcome;
  }

  @Get('wagering/transactions/:transactionId')
  async get(@Param('transactionId') transactionId: string) {
    return this.container.queries.getTransaction(uuidParam('transactionId', transactionId));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async getByExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    assertMayActFor(principalOf(request), providerId);
    return this.container.queries.getTransactionByExternalId(providerId, externalTransactionId);
  }
}

@Controller()
@Public()
export class HealthController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get()
  @Redirect('/docs', 302)
  root() {}

  @Get('health/live')
  live() {
    return { status: 'ok' };
  }

  @Get('health/ready')
  async ready(@Res({ passthrough: true }) response: Response) {
    const check = async (probe: () => Promise<void>) => {
      try {
        await withTimeout(probe(), 2_000);
        return 'up' as const;
      } catch {
        return 'down' as const;
      }
    };
    const [postgres, sqs] = await Promise.all([
      check(() => this.container.unitOfWork.ping()),
      check(() => this.container.queues.ping(this.container.config.queues.transactions)),
    ]);
    const ready = postgres === 'up' && sqs === 'up';
    response.status(ready ? 200 : 503);
    return { status: ready ? 'ok' : 'unavailable', checks: { postgres, sqs } };
  }

  @Get('metrics')
  async metrics(@Res() response: Response) {
    const { contentType, body } = await this.container.metrics.render();
    response.setHeader('Content-Type', contentType);
    response.send(body);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms).unref()),
  ]);
}
