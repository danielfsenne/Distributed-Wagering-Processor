import type { MoneyProps } from '../../domain/shared/money';
import { NotFoundError } from '../errors';
import type { Logger, Metrics, UnitOfWork } from '../ports';

export interface ReconciliationReport {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

export class ReconcileWallet {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly metrics: Metrics,
    private readonly logger: Logger,
  ) {}

  async execute(walletId: string): Promise<ReconciliationReport> {
    const report = await this.unitOfWork.run(async (scope) => {
      const wallet = await scope.wallets.lockForShareById(walletId);
      if (!wallet) throw NotFoundError.wallet(walletId);
      const summary = await scope.ledger.summarize(walletId, wallet.currency);
      const difference = wallet.balance.subtract(summary.calculatedBalance);
      return {
        walletId,
        storedBalance: wallet.balance.toJSON(),
        calculatedBalance: summary.calculatedBalance.toJSON(),
        difference: difference.toJSON(),
        consistent: difference.isZero(),
        checkedEntries: summary.entryCount,
      };
    });

    if (!report.consistent) {
      this.metrics.reconciliationDivergence();
      this.logger.error('wallet reconciliation divergence', {
        walletId,
        difference: report.difference.amount,
        checkedEntries: report.checkedEntries,
      });
    } else {
      this.logger.info('wallet reconciled', { walletId, checkedEntries: report.checkedEntries });
    }
    return report;
  }
}
