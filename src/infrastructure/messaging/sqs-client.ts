import { GetQueueAttributesCommand, GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { TransientError } from '../../application/errors';

export interface SqsSettings {
  endpoint: string | undefined;
  region: string;
}

export function createSqsClient(settings: SqsSettings): SQSClient {
  return new SQSClient({
    region: settings.region,
    ...(settings.endpoint ? { endpoint: settings.endpoint } : {}),
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
    maxAttempts: 3,
  });
}

export class QueueUrlResolver {
  private readonly cache = new Map<string, string>();

  constructor(private readonly client: SQSClient) {}

  async resolve(queueName: string): Promise<string> {
    const cached = this.cache.get(queueName);
    if (cached) return cached;
    try {
      const { QueueUrl } = await this.client.send(new GetQueueUrlCommand({ QueueName: queueName }));
      if (!QueueUrl) throw new Error(`Queue ${queueName} has no URL`);
      this.cache.set(queueName, QueueUrl);
      return QueueUrl;
    } catch (error) {
      throw new TransientError(`could not resolve queue ${queueName}`, error);
    }
  }

  async ping(queueName: string): Promise<void> {
    const url = await this.resolve(queueName);
    await this.client.send(
      new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['QueueArn'] }),
    );
  }
}
