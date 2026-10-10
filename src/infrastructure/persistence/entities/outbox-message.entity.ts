import { defineEntity, p } from '@mikro-orm/postgresql';

export const OutboxMessageEntity = defineEntity({
  name: 'OutboxMessage',
  tableName: 'outbox_messages',
  properties: {
    id: p.uuid().primary(),
    aggregateId: p.uuid().fieldName('aggregate_id'),
    eventType: p.string().fieldName('event_type').length(100),
    payload: p.json().$type<Record<string, unknown>>().columnType('jsonb'),
    occurredAt: p.datetime().fieldName('occurred_at').columnType('timestamptz'),
    attempts: p.integer().default(0),
    nextAttemptAt: p.datetime().fieldName('next_attempt_at').columnType('timestamptz').defaultRaw('current_timestamp'),
    claimedBy: p.string().fieldName('claimed_by').length(255).nullable(),
    claimedUntil: p.datetime().fieldName('claimed_until').columnType('timestamptz').nullable(),
    publishedAt: p.datetime().fieldName('published_at').columnType('timestamptz').nullable(),
  },
  indexes: [
    {
      name: 'outbox_messages_pending_idx',
      properties: ['nextAttemptAt', 'occurredAt', 'id'],
      where: { publishedAt: null },
    },
  ],
  checks: [
    {
      name: 'outbox_messages_attempts_check',
      expression: (columns) => `${columns.attempts} >= 0`,
    },
    {
      name: 'outbox_messages_payload_object_check',
      expression: (columns) => `jsonb_typeof(${columns.payload}) = 'object'`,
    },
    {
      name: 'outbox_messages_claim_check',
      expression: (columns) => `(${columns.claimedBy} IS NULL) = (${columns.claimedUntil} IS NULL)`,
    },
  ],
});
