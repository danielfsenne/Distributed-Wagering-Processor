import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { ApplicationError, TransientError } from '../../application/errors';
import { sha256Hex } from '../../application/idempotency/payload-hash';
import type { Logger, Metrics } from '../../application/ports';
import type { ProviderPrincipal } from '../../application/provider-access';
import type { SubmitWagerTransaction } from '../../application/wagering/submit-wager-transaction';
import { DomainError } from '../../domain/shared/domain-error';
import { runWithLogContext } from '../observability/log-context';
import type { QueueUrlResolver } from './sqs-client';
import { parseWagerMessage } from './wager-message';

export interface SqsConsumerOptions {
  queueName: string;
  deadLetterQueueName: string;
  consumerName: string;
  principal: ProviderPrincipal;
  maxAttempts: number;
  concurrency: number;
  waitTimeSeconds: number;
  visibilityTimeoutSeconds: number;
  retryBaseDelaySeconds: number;
  retryMaxDelaySeconds: number;
}

export type MessageDisposition =
  | { kind: 'ack' }
  | { kind: 'retry'; delaySeconds: number; reason: string }
  | { kind: 'dead-letter'; reason: string };

type FailureClass = 'permanent' | 'transient';

export function classifyFailure(error: unknown): FailureClass {
  if (error instanceof TransientError) return 'transient';
  if (error instanceof ApplicationError || error instanceof DomainError) return 'permanent';
  return 'transient';
}

export class SqsWagerConsumer {
  private running = false;
  private pollers: Promise<void>[] = [];
  private readonly abort = new AbortController();
  private readonly inFlight = new Set<Promise<unknown>>();
  private readonly waiting = new Map<string, Message>();

  constructor(
    private readonly sqs: SQSClient,
    private readonly queues: QueueUrlResolver,
    private readonly submitWager: SubmitWagerTransaction,
    private readonly metrics: Metrics,
    private readonly logger: Logger,
    private readonly options: SqsConsumerOptions,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    const pollerCount = Math.max(1, Math.ceil(this.options.concurrency / 10));
    this.pollers = Array.from({ length: pollerCount }, () => this.poll());
    this.logger.info('sqs consumer started', {
      queue: this.options.queueName,
      consumer: this.options.consumerName,
    });
  }

  async stop(timeoutMs: number): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.abort.abort();
    await Promise.allSettled(this.pollers);
    const drained = await Promise.race([
      Promise.allSettled([...this.inFlight]).then(() => true),
      Bun.sleep(timeoutMs).then(() => false),
    ]);
    await this.releaseWaiting();
    this.logger.info('sqs consumer stopped', { drained, released: this.waiting.size });
  }

  async processBatch(messages: Message[]): Promise<void> {
    const groups = new Map<string, Message[]>();
    for (const message of messages) {
      const group = message.Attributes?.MessageGroupId ?? message.MessageId ?? 'default';
      const list = groups.get(group) ?? [];
      list.push(message);
      groups.set(group, list);
      if (message.ReceiptHandle) this.waiting.set(message.ReceiptHandle, message);
    }
    await Promise.all(
      [...groups.values()].map(async (groupMessages) => {
        for (const message of groupMessages) {
          if (!this.running && this.pollers.length > 0) return;
          if (message.ReceiptHandle) this.waiting.delete(message.ReceiptHandle);
          const work = this.handle(message);
          this.inFlight.add(work);
          try {
            await work;
          } finally {
            this.inFlight.delete(work);
          }
        }
      }),
    );
  }

  async handle(message: Message): Promise<MessageDisposition> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
    const disposition = await this.decide(message, receiveCount);
    await this.settle(message, disposition);
    return disposition;
  }

  private async decide(message: Message, receiveCount: number): Promise<MessageDisposition> {
    const body = message.Body ?? '';
    let parsed: ReturnType<typeof parseWagerMessage>;
    try {
      parsed = parseWagerMessage(body);
    } catch (error) {
      this.logger.warn('invalid wager message', {
        sqsMessageId: message.MessageId,
        error: (error as Error).message,
      });
      return { kind: 'dead-letter', reason: 'invalid_message' };
    }

    const context = {
      correlationId: parsed.correlationId ?? parsed.messageId,
      messageId: parsed.messageId,
      walletId: parsed.payload.walletId,
      providerId: parsed.payload.providerId,
    };
    return runWithLogContext(context, async () => {
      try {
        const outcome = await this.submitWager.execute({
          idempotencyKey: parsed.idempotencyKey,
          payload: parsed.payload,
          principal: this.options.principal,
          correlationId: context.correlationId,
          causationId: parsed.messageId,
          source: 'sqs',
          inbox: {
            consumerName: this.options.consumerName,
            messageId: parsed.messageId,
            messageHash: sha256Hex(body),
          },
        });
        this.logger.debug('wager message processed', {
          transactionId: outcome.transactionId,
          status: outcome.status,
          receiveCount,
        });
        return { kind: 'ack' } as const;
      } catch (error) {
        return this.onFailure(error, receiveCount);
      }
    });
  }

  private onFailure(error: unknown, receiveCount: number): MessageDisposition {
    const failure = classifyFailure(error);
    const code = error instanceof ApplicationError || error instanceof DomainError ? error.code : 'UNEXPECTED';
    if (failure === 'permanent') {
      this.logger.warn('wager message failed permanently', { code, error: (error as Error).message });
      return { kind: 'dead-letter', reason: code.toLowerCase() };
    }
    if (receiveCount >= this.options.maxAttempts) {
      this.logger.error('wager message exhausted retries', { code, receiveCount, error: (error as Error).message });
      return { kind: 'dead-letter', reason: 'retries_exhausted' };
    }
    const delaySeconds = Math.min(
      this.options.retryBaseDelaySeconds * 2 ** (receiveCount - 1),
      this.options.retryMaxDelaySeconds,
    );
    this.logger.warn('wager message will be retried', {
      code,
      receiveCount,
      delaySeconds,
      error: (error as Error).message,
    });
    return { kind: 'retry', delaySeconds, reason: code.toLowerCase() };
  }

  private async settle(message: Message, disposition: MessageDisposition): Promise<void> {
    const queueUrl = await this.queues.resolve(this.options.queueName);
    switch (disposition.kind) {
      case 'ack':
        await this.delete(queueUrl, message);
        return;
      case 'retry':
        this.metrics.retry('sqs-consumer', disposition.reason);
        await this.sqs.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: queueUrl,
            ReceiptHandle: message.ReceiptHandle,
            VisibilityTimeout: disposition.delaySeconds,
          }),
        );
        return;
      case 'dead-letter':
        await this.deadLetter(message, disposition.reason);
        await this.delete(queueUrl, message);
        this.metrics.deadLettered(disposition.reason);
        return;
    }
  }

  private async deadLetter(message: Message, reason: string): Promise<void> {
    const dlqUrl = await this.queues.resolve(this.options.deadLetterQueueName);
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: dlqUrl,
        MessageBody: message.Body ?? '',
        MessageGroupId: message.Attributes?.MessageGroupId ?? 'dead-letter',
        MessageDeduplicationId: message.MessageId ?? sha256Hex(message.Body ?? ''),
        MessageAttributes: {
          reason: { DataType: 'String', StringValue: reason },
          originalMessageId: { DataType: 'String', StringValue: message.MessageId ?? 'unknown' },
          receiveCount: {
            DataType: 'Number',
            StringValue: message.Attributes?.ApproximateReceiveCount ?? '1',
          },
        },
      }),
    );
  }

  private async delete(queueUrl: string, message: Message): Promise<void> {
    await this.sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
  }

  private async poll(): Promise<void> {
    while (this.running) {
      try {
        const queueUrl = await this.queues.resolve(this.options.queueName);
        const capacity = Math.max(1, Math.min(10, this.options.concurrency));
        const response = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: capacity,
            WaitTimeSeconds: this.options.waitTimeSeconds,
            VisibilityTimeout: this.options.visibilityTimeoutSeconds,
            MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
          }),
          { abortSignal: this.abort.signal },
        );
        const messages = response.Messages ?? [];
        if (messages.length > 0) {
          await this.processBatch(messages);
        }
      } catch (error) {
        if (!this.running) return;
        this.logger.error('sqs receive failed', { error: (error as Error).message });
        await Bun.sleep(1_000);
      }
    }
  }

  private async releaseWaiting(): Promise<void> {
    if (this.waiting.size === 0) return;
    const queueUrl = await this.queues.resolve(this.options.queueName);
    await Promise.allSettled(
      [...this.waiting.values()].map((message) =>
        this.sqs.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: queueUrl,
            ReceiptHandle: message.ReceiptHandle,
            VisibilityTimeout: 0,
          }),
        ),
      ),
    );
  }
}
