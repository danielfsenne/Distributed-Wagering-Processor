#!/bin/sh
# Creates the SQS queues on LocalStack startup. Idempotent: create-queue returns the
# existing URL when the queue already exists with the same attributes.
set -e

create_fifo() {
  awslocal sqs create-queue --queue-name "$1" --attributes "$2" >/dev/null
  echo "queue ready: $1"
}

DLQ_ATTRS='{"FifoQueue":"true","ContentBasedDeduplication":"false","MessageRetentionPeriod":"1209600"}'

create_fifo wager-transactions-dlq.fifo "$DLQ_ATTRS"
DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --queue-url http://localhost:4566/000000000000/wager-transactions-dlq.fifo \
  --attribute-names QueueArn --query Attributes.QueueArn --output text)

# maxReceiveCount is the broker-side safety net; the consumer moves messages to the DLQ
# itself once its own attempt limit is reached.
create_fifo wager-transactions.fifo "{\"FifoQueue\":\"true\",\"ContentBasedDeduplication\":\"false\",\"VisibilityTimeout\":\"30\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"$DLQ_ARN\\\",\\\"maxReceiveCount\\\":\\\"10\\\"}\"}"

# Integration events published by the outbox.
create_fifo wagering-events.fifo '{"FifoQueue":"true","ContentBasedDeduplication":"false"}'

# Queues used only by the test suites, so tests never compete with running workers.
create_fifo test-wager-transactions-dlq.fifo "$DLQ_ATTRS"
create_fifo test-wager-transactions.fifo '{"FifoQueue":"true","ContentBasedDeduplication":"false","VisibilityTimeout":"30"}'
create_fifo test-wagering-events.fifo '{"FifoQueue":"true","ContentBasedDeduplication":"false"}'
