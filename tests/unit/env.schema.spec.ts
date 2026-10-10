import { describe, expect, it } from 'bun:test';
import { validateEnv } from '@/infrastructure/config/env.schema';

describe('environment configuration', () => {
  it('accepts valid application and database ports', () => {
    expect(validateEnv(validConfiguration({ PORT: '3000', DATABASE_PORT: '5432' }))).toMatchObject({
      PORT: 3000,
      DATABASE_PORT: 5432,
    });
  });

  it('rejects ports outside the valid TCP port range or with fractional values', () => {
    for (const port of ['0', '-1', '65536', '3000.5', 'not-a-port']) {
      expect(() => validateEnv(validConfiguration({ PORT: port }))).toThrow();
      expect(() => validateEnv(validConfiguration({ DATABASE_PORT: port }))).toThrow();
    }
  });
});

function validConfiguration(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    NODE_ENV: 'test',
    PORT: '3000',
    DATABASE_HOST: 'localhost',
    DATABASE_PORT: '5432',
    DATABASE_USER: 'postgres',
    DATABASE_PASSWORD: 'postgres',
    DATABASE_NAME: 'wagering_db',
    AWS_REGION: 'us-east-1',
    AWS_ENDPOINT: 'http://localhost:4566',
    AWS_ACCESS_KEY_ID: 'test',
    AWS_SECRET_ACCESS_KEY: 'test',
    SQS_QUEUE_URL: 'http://localhost:4566/000000000000/wager-transactions.fifo',
    SQS_DLQ_URL: 'http://localhost:4566/000000000000/wager-transactions-dlq.fifo',
    SQS_EVENTS_QUEUE_URL: 'http://localhost:4566/000000000000/wager-events.fifo',
    ...overrides,
  };
}
