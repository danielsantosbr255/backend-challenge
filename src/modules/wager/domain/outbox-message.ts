import type { IntegrationEvent } from './integration-event';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date;
  publishedAt?: Date;
}

export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt: Date,
    private _publishedAt?: Date,
  ) {}

  static enqueue(event: IntegrationEvent<Record<string, unknown>>): OutboxMessage {
    return new OutboxMessage(event.eventId, event.aggregateId, event.eventType,
      Object.freeze(event.toJSON()), event.occurredAt, 0, event.occurredAt);
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(state.id, state.aggregateId, state.eventType,
      Object.freeze({ ...state.payload }), state.occurredAt, state.attempts, state.nextAttemptAt, state.publishedAt);
  }

  get attempts(): number { return this._attempts; }
  get nextAttemptAt(): Date { return this._nextAttemptAt; }
  get publishedAt(): Date | undefined { return this._publishedAt; }
  isPending(): boolean { return this._publishedAt === undefined; }
  isDue(now: Date): boolean { return this.isPending() && this._nextAttemptAt.getTime() <= now.getTime(); }

  markPublished(at: Date): void {
    this.assertPending();
    this._attempts += 1;
    this._publishedAt = at;
  }

  scheduleRetry(now: Date): void {
    this.assertPending();
    this._attempts += 1;
    const seconds = Math.min(2 ** Math.min(this._attempts - 1, 9), 300);
    this._nextAttemptAt = new Date(now.getTime() + seconds * 1000);
  }

  private assertPending(): void {
    if (!this.isPending()) throw new Error('Outbox message is already published');
  }
}
