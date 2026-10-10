import { describe, expect, it } from 'bun:test';
import { InboxMessage } from '@/modules/wager/domain/inbox-message';
import { OutboxMessage } from '@/modules/wager/domain/outbox-message';
import { WagerTransactionProcessed } from '@/modules/wager/domain/integration-event';

const now = new Date('2026-10-10T12:00:00.000Z');

describe('InboxMessage', () => {
  it('receives once and rehydrates the committed processing state without repeating a transition', () => {
    const message = InboxMessage.receive({ messageId: 'message-1', consumerName: 'wager-v1', payloadHash: 'a'.repeat(64), receivedAt: now });
    expect(message.isProcessed()).toBe(false);
    message.markProcessed(now);
    expect(message.isProcessed()).toBe(true);
    expect(() => message.markProcessed(now)).toThrow();
    const restored = InboxMessage.rehydrate({
      messageId: message.messageId, consumerName: message.consumerName,
      payloadHash: message.payloadHash, receivedAt: message.receivedAt, processedAt: message.processedAt,
    });
    expect(restored.processedAt).toEqual(now);
  });
});

describe('OutboxMessage', () => {
  function enqueue() {
    return OutboxMessage.enqueue(new WagerTransactionProcessed({
      eventId: crypto.randomUUID(), aggregateId: crypto.randomUUID(), correlationId: 'external-1', occurredAt: now,
      data: { transactionId: crypto.randomUUID(), providerId: 'provider-1', externalTransactionId: 'external-1',
        status: 'PROCESSED', balance: { amount: '10.00', currency: 'BRL' } },
    }));
  }

  it('keeps event identity and schedules bounded exponential retries before publishing', () => {
    const message = enqueue();
    const id = message.id;
    expect(message.isDue(now)).toBe(true);
    message.scheduleRetry(now);
    expect(message.attempts).toBe(1);
    expect(message.isDue(now)).toBe(false);
    expect(message.nextAttemptAt).toEqual(new Date(now.getTime() + 1000));
    message.scheduleRetry(now);
    expect(message.nextAttemptAt).toEqual(new Date(now.getTime() + 2000));
    for (let attempt = 0; attempt < 20; attempt += 1) message.scheduleRetry(now);
    expect(message.nextAttemptAt).toEqual(new Date(now.getTime() + 300_000));
    message.markPublished(now);
    expect(message.id).toBe(id);
    expect(message.isPending()).toBe(false);
    expect(message.isDue(now)).toBe(false);
    expect(() => message.scheduleRetry(now)).toThrow();
    expect(() => message.markPublished(now)).toThrow();
  });

  it('rehydrates a published message without scheduling or publishing it again', () => {
    const message = enqueue();
    const restored = OutboxMessage.rehydrate({
      id: message.id, aggregateId: message.aggregateId, eventType: message.eventType,
      payload: message.payload, occurredAt: now, attempts: 3, nextAttemptAt: now, publishedAt: now,
    });
    expect(restored.attempts).toBe(3);
    expect(restored.publishedAt).toEqual(now);
    expect(restored.isPending()).toBe(false);
  });
});
