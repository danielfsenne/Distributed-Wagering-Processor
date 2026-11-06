import { WalletBalanceChanged } from '../../domain/messaging/events';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { DomainError } from '../../domain/shared/domain-error';
import { newId } from '../../domain/shared/id';
import { Money, type MoneyProps } from '../../domain/shared/money';
import { WagerTransaction } from '../../domain/wagering/wager-transaction';
import { Wallet } from '../../domain/wallet/wallet';
import { UniqueViolationError, ValidationError, WalletAlreadyExistsError } from '../errors';
import { payloadHash } from '../idempotency/payload-hash';
import type { Clock, Logger, UnitOfWork } from '../ports';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface OpenWalletCommand {
  playerId: string;
  initialBalance: Money;
  correlationId: string;
}

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export function toWalletView(wallet: Wallet): WalletView {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
  };
}

export function parseOpenWalletBody(raw: unknown): Omit<OpenWalletCommand, 'correlationId'> {
  const body = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const issues = [];
  const playerId = body.playerId;
  if (typeof playerId !== 'string' || !UUID_PATTERN.test(playerId)) {
    issues.push({ field: 'playerId', message: 'must be a UUID' });
  }
  let initialBalance: Money | undefined;
  try {
    initialBalance = Money.from(body.initialBalance as MoneyProps);
  } catch (error) {
    issues.push({
      field: 'initialBalance',
      message: error instanceof DomainError ? error.message : 'must be { amount, currency }',
    });
  }
  if (issues.length > 0 || !initialBalance) {
    throw ValidationError.invalidPayload(issues);
  }
  return { playerId: (playerId as string).toLowerCase(), initialBalance };
}

export class OpenWallet {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  async execute(command: OpenWalletCommand): Promise<WalletView> {
    try {
      const wallet = await this.unitOfWork.run(async (scope) => {
        const now = this.clock.now();
        const walletId = newId();
        const opening = command.initialBalance.isPositive()
          ? WagerTransaction.opening({
              walletId,
              playerId: command.playerId,
              money: command.initialBalance,
              payloadHash: payloadHash({
                walletId,
                playerId: command.playerId,
                initialBalance: command.initialBalance.toJSON(),
              }),
              at: now,
            })
          : undefined;
        const { wallet, openingEntry } = Wallet.open({
          id: walletId,
          playerId: command.playerId,
          initialBalance: command.initialBalance,
          openingTransactionId: opening?.id,
          at: now,
        });

        await scope.wallets.insert(wallet);
        if (opening && openingEntry) {
          await scope.transactions.insert(opening);
          await scope.ledger.append(openingEntry);
          await scope.outbox.enqueue([
            OutboxMessage.enqueue(
              WalletBalanceChanged.from(wallet, openingEntry, {
                correlationId: command.correlationId,
                causationId: opening.id,
                occurredAt: now,
              }),
            ),
          ]);
        }
        return wallet;
      });
      this.logger.info('wallet opened', { walletId: wallet.id, currency: wallet.currency });
      return toWalletView(wallet);
    } catch (error) {
      if (error instanceof UniqueViolationError && error.constraint === 'wallets_player_currency_key') {
        throw new WalletAlreadyExistsError(command.playerId, command.initialBalance.currency);
      }
      throw error;
    }
  }
}
