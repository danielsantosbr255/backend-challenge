import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { MetricsService } from '@/common/observability/metrics.service';
import { PermanentInfrastructureError } from '@/common/errors/permanent-infrastructure.error';
import { ConfigService } from '@nestjs/config';
import { delay, exponentialBackoffSeconds } from '@/common/async/retry';
import { SQS_CLIENT } from '@/infrastructure/messaging/sqs-client.provider';
import { parseWagerMessage } from '@/infrastructure/messaging/wager-message';
import { ProcessWagerUseCase } from './use-cases/process-wager.use-case';
import { InboxMessageConflictError, isTerminalWagerError } from './wager.errors';

const CONSUMER_NAME = 'wager-transactions-v1';

@Injectable()
export class WagerSqsConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WagerSqsConsumer.name);
  private running = false;
  private loop: Promise<void> | undefined;
  private readonly queueUrl: string;
  private readonly dlqUrl: string;

  constructor(
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    private readonly config: ConfigService,
    private readonly processWager: ProcessWagerUseCase,
    private readonly metrics: MetricsService,
  ) {
    this.queueUrl = this.config.getOrThrow<string>('SQS_QUEUE_URL');
    this.dlqUrl = this.config.getOrThrow<string>('SQS_DLQ_URL');
  }

  onModuleInit(): void {
    this.running = true;
    this.loop = this.poll();
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;
    await this.loop;
  }

  private async poll(): Promise<void> {
    while (this.running) {
      try {
        const dlq = await this.sqs.send(new GetQueueAttributesCommand({
          QueueUrl: this.dlqUrl, AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
        }));
        const visible = Number(dlq.Attributes?.['ApproximateNumberOfMessages'] ?? '0');
        const inFlight = Number(dlq.Attributes?.['ApproximateNumberOfMessagesNotVisible'] ?? '0');
        if (Number.isSafeInteger(visible) && visible >= 0 && Number.isSafeInteger(inFlight) && inFlight >= 0) {
          this.metrics.setDlqDepth(visible + inFlight);
        }
        const result = await this.sqs.send(new ReceiveMessageCommand({
          QueueUrl: this.queueUrl,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: 10,
          VisibilityTimeout: 60,
          MessageSystemAttributeNames: ['ApproximateReceiveCount'],
        }));
        for (const message of result.Messages ?? []) {
          if (!this.running) {
            await this.release(message, 0);
            continue;
          }
          await this.processMessage(message);
        }
      } catch (error: unknown) {
        this.logger.error('wager_message_poll_retry', {
          event: 'wager_message_poll_retry',
          errorType: error instanceof Error ? error.name : 'UnknownError',
        });
        await delay(1000);
      }
    }
  }

  private async processMessage(message: Message): Promise<void> {
    if (message.ReceiptHandle === undefined) return;
    let context = {
      messageId: message.MessageId ?? 'unknown',
      providerId: 'unknown',
      walletId: 'unknown',
      transactionId: 'unknown',
      correlationId: 'unknown',
    };
    try {
      const parsed = parseWagerMessage(message.Body);
      if (parsed === undefined) {
        await this.moveToDlq(message, context);
        return;
      }
      context = {
        messageId: parsed.messageId,
        providerId: parsed.data.providerId,
        walletId: parsed.data.walletId,
        transactionId: 'unknown',
        correlationId: parsed.data.externalTransactionId,
      };
      const result = await this.processWager.execute(parsed.data, {
        consumerName: CONSUMER_NAME,
        messageId: parsed.messageId,
      });
      context.transactionId = result.transactionId;
      this.logger.log('wager_message_processed', { event: 'wager_message_processed', ...context, status: result.status });
      if (result.status === 'FAILED') {
        await this.moveToDlq(message, context);
        return;
      }
      await this.ack(message.ReceiptHandle);
    } catch (error: unknown) {
      if (isTerminalWagerError(error)) {
        await this.ack(message.ReceiptHandle);
        return;
      }
      if (error instanceof InboxMessageConflictError || error instanceof PermanentInfrastructureError) {
        await this.moveToDlq(message, context);
        return;
      }
      this.logger.error('wager_message_retry', {
        event: 'wager_message_retry',
        ...context,
        errorType: error instanceof Error ? error.name : 'UnknownError',
      });
      this.metrics.recordRetry('sqs');
      await this.defer(message);
    }
  }

  private async ack(receiptHandle: string): Promise<void> {
    await this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: receiptHandle }));
  }

  private async defer(message: Message): Promise<void> {
    if (message.ReceiptHandle === undefined) return;
    const attempts = Number(message.Attributes?.['ApproximateReceiveCount'] ?? '1');
    const seconds = exponentialBackoffSeconds(attempts, 30);
    await this.release(message, seconds);
  }

  private async release(message: Message, seconds: number): Promise<void> {
    if (message.ReceiptHandle === undefined) return;
    await this.sqs.send(new ChangeMessageVisibilityCommand({
      QueueUrl: this.queueUrl,
      ReceiptHandle: message.ReceiptHandle,
      VisibilityTimeout: seconds,
    }));
  }

  private async moveToDlq(message: Message, context: Record<string, string>): Promise<void> {
    if (message.ReceiptHandle === undefined || message.Body === undefined) return;
    await this.sqs.send(new SendMessageCommand({
      QueueUrl: this.dlqUrl,
      MessageBody: message.Body,
      MessageGroupId: 'invalid-wager-message',
      MessageDeduplicationId: message.MessageId ?? message.ReceiptHandle,
    }));
    this.metrics.recordDlqMessage();
    this.logger.warn('wager_message_moved_to_dlq', {
      event: 'wager_message_moved_to_dlq',
      ...context,
    });
    await this.ack(message.ReceiptHandle);
  }
}
