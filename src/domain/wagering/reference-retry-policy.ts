export interface ReferenceRetryPolicyProps {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export class ReferenceRetryPolicy {
  static readonly DEFAULT = new ReferenceRetryPolicy({
    maxAttempts: 12,
    baseDelayMs: 1_000,
    maxDelayMs: 300_000,
  });

  private constructor(private readonly props: ReferenceRetryPolicyProps) {}

  static of(props: ReferenceRetryPolicyProps): ReferenceRetryPolicy {
    if (props.maxAttempts < 1 || props.baseDelayMs < 0 || props.maxDelayMs < props.baseDelayMs) {
      throw new Error('Invalid reference retry policy');
    }
    return new ReferenceRetryPolicy({ ...props });
  }

  get maxAttempts(): number {
    return this.props.maxAttempts;
  }

  isExhausted(attemptsMade: number): boolean {
    return attemptsMade >= this.props.maxAttempts;
  }

  delayFor(attemptsMade: number): number {
    const exponent = Math.max(0, attemptsMade - 1);
    return Math.min(this.props.baseDelayMs * 2 ** exponent, this.props.maxDelayMs);
  }

  nextAttemptAt(attemptsMade: number, now: Date): Date {
    return new Date(now.getTime() + this.delayFor(attemptsMade));
  }
}
