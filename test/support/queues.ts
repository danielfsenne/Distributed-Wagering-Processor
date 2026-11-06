import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { newId } from '../../src/domain/shared/id';

export interface TestQueues {
  main: string;
  deadLetter: string;
  events: string;
  urls: { main: string; deadLetter: string; events: string };
  cleanup(): Promise<void>;
}

export async function createTestQueues(sqs: SQSClient, visibilityTimeout = 30): Promise<TestQueues> {
  const suffix = newId().slice(-12);
  const names = {
    main: `t-${suffix}-tx.fifo`,
    deadLetter: `t-${suffix}-dlq.fifo`,
    events: `t-${suffix}-events.fifo`,
  };
  const create = async (name: string, attributes: Record<string, string> = {}) => {
    const { QueueUrl } = await sqs.send(
      new CreateQueueCommand({
        QueueName: name,
        Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false', ...attributes },
      }),
    );
    return QueueUrl!;
  };
  const urls = {
    main: await create(names.main, { VisibilityTimeout: String(visibilityTimeout) }),
    deadLetter: await create(names.deadLetter),
    events: await create(names.events),
  };
  return {
    ...names,
    urls,
    async cleanup() {
      await Promise.allSettled(Object.values(urls).map((url) => sqs.send(new DeleteQueueCommand({ QueueUrl: url }))));
    },
  };
}

export async function sendWagerMessage(
  sqs: SQSClient,
  queueUrl: string,
  body: unknown,
  options: { groupId: string; deduplicationId?: string },
): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: typeof body === 'string' ? body : JSON.stringify(body),
      MessageGroupId: options.groupId,
      MessageDeduplicationId: options.deduplicationId ?? newId(),
    }),
  );
}

export async function receiveAll(sqs: SQSClient, queueUrl: string, waitSeconds = 1): Promise<Message[]> {
  const messages: Message[] = [];
  for (;;) {
    const { Messages = [] } = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: waitSeconds,
        VisibilityTimeout: 60,
        MessageAttributeNames: ['All'],
        MessageSystemAttributeNames: ['All'],
      }),
    );
    if (Messages.length === 0) return messages;
    messages.push(...Messages);
  }
}

export async function approximateCount(sqs: SQSClient, queueUrl: string): Promise<number> {
  const { Attributes = {} } = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  return Number(Attributes.ApproximateNumberOfMessages ?? 0) + Number(Attributes.ApproximateNumberOfMessagesNotVisible ?? 0);
}

export async function waitFor<T>(
  probe: () => Promise<T | undefined | false>,
  { timeoutMs = 15_000, intervalMs = 100, description = 'condition' } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`);
    await Bun.sleep(intervalMs);
  }
}

export function wagerMessage(data: Record<string, unknown>, messageId = `msg-${newId()}`) {
  return {
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data,
  };
}
