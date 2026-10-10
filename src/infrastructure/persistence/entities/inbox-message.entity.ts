import { defineEntity, p } from '@mikro-orm/postgresql';

export const InboxMessageEntity = defineEntity({
  name: 'InboxMessage',
  tableName: 'inbox_messages',
  properties: {
    consumerName: p.string().primary().fieldName('consumer_name').length(100),
    messageId: p.string().primary().fieldName('message_id').length(255),
    payloadHash: p.string().fieldName('payload_hash').columnType('char(64)'),
    receivedAt: p.datetime().fieldName('received_at').columnType('timestamptz').defaultRaw('current_timestamp'),
    processedAt: p.datetime().fieldName('processed_at').columnType('timestamptz').nullable(),
  },
  checks: [
    {
      name: 'inbox_messages_payload_hash_check',
      expression: (columns) => `${columns.payloadHash} ~ '^[0-9a-f]{64}$'`,
    },
  ],
});
