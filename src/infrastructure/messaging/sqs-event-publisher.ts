import {
  type MessageAttributeValue,
  SendMessageBatchCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type { EventPublisher, PublishableEvent, PublishFailure } from '../../application/ports';
import type { QueueUrlResolver } from './sqs-client';

const SQS_BATCH_LIMIT = 10;

function attributes(event: PublishableEvent): Record<string, MessageAttributeValue> {
  return {
    eventType: { DataType: 'String', StringValue: event.eventType },
    eventId: { DataType: 'String', StringValue: event.id },
  };
}

export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly client: SQSClient,
    private readonly queues: QueueUrlResolver,
    private readonly queueName: string,
  ) {}

  async publish(event: PublishableEvent): Promise<void> {
    const queueUrl = await this.queues.resolve(this.queueName);
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(event.payload),
        MessageGroupId: event.aggregateId,
        MessageDeduplicationId: event.id,
        MessageAttributes: attributes(event),
      }),
    );
  }

  async publishAll(events: PublishableEvent[]): Promise<PublishFailure[]> {
    const queueUrl = await this.queues.resolve(this.queueName);
    const failures: PublishFailure[] = [];
    for (let start = 0; start < events.length; start += SQS_BATCH_LIMIT) {
      const chunk = events.slice(start, start + SQS_BATCH_LIMIT);
      try {
        const response = await this.client.send(
          new SendMessageBatchCommand({
            QueueUrl: queueUrl,
            Entries: chunk.map((event, index) => ({
              Id: String(index),
              MessageBody: JSON.stringify(event.payload),
              MessageGroupId: event.aggregateId,
              MessageDeduplicationId: event.id,
              MessageAttributes: attributes(event),
            })),
          }),
        );
        for (const failed of response.Failed ?? []) {
          const event = chunk[Number(failed.Id)];
          if (event) failures.push({ id: event.id, error: `${failed.Code}: ${failed.Message ?? ''}` });
        }
      } catch (error) {
        failures.push(...chunk.map((event) => ({ id: event.id, error: (error as Error).message })));
      }
    }
    return failures;
  }
}
