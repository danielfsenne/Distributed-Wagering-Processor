import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { EventPublisher, PublishableEvent } from '../../application/ports';
import type { QueueUrlResolver } from './sqs-client';

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
        MessageAttributes: {
          eventType: { DataType: 'String', StringValue: event.eventType },
          eventId: { DataType: 'String', StringValue: event.id },
        },
      }),
    );
  }
}
