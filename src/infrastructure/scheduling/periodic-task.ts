import type { Logger } from '../../application/ports';

export interface PeriodicTaskOptions {
  name: string;
  intervalMs: number;
  run: () => Promise<{ busy: boolean }>;
  logger: Logger;
}

export class PeriodicTask {
  private running = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(private readonly options: PeriodicTaskOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.execute();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
  }

  private async execute(): Promise<void> {
    while (this.running) {
      let busy = false;
      try {
        busy = (await this.options.run()).busy;
      } catch (error) {
        this.options.logger.error('periodic task failed', {
          task: this.options.name,
          error: (error as Error).message,
        });
      }
      if (!busy && this.running) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, this.options.intervalMs);
          this.wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        this.wake = undefined;
      }
    }
  }
}
