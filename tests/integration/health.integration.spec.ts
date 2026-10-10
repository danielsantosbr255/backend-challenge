import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

interface ReadinessResponse {
  status: string;
  details: {
    database: string;
    sqs: string;
  };
}

describe('Health HTTP integration (PostgreSQL and LocalStack)', () => {
  let app: INestApplication | undefined;

  beforeAll(async () => {
    process.env.SQS_EVENTS_QUEUE_URL ??= 'http://localhost:4566/000000000000/wager-events.fifo';
    const { AppModule } = await import('@/app.module');
    app = await NestFactory.create(AppModule, { logger: false });
    await app.listen(0, '127.0.0.1');
  }, 30_000);

  afterAll(async () => {
    await app?.close();
  }, 30_000);

  it('returns ready over HTTP when the configured database and queues are available', async () => {
    if (!app) {
      throw new Error('NestJS application did not start');
    }

    const response = await fetch(`${await app.getUrl()}/health/ready`);
    const body: unknown = await response.json();

    expect(response.status).toBe(200);
    expect(isReadinessResponse(body)).toBe(true);

    if (!isReadinessResponse(body)) {
      throw new Error('Health response did not match the expected contract');
    }

    expect(body.status).toBe('ok');
    expect(body.details).toEqual({ database: 'up', sqs: 'up' });
  });
});

function isReadinessResponse(value: unknown): value is ReadinessResponse {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const details = Reflect.get(value, 'details');
  return (
    typeof Reflect.get(value, 'status') === 'string' &&
    typeof details === 'object' &&
    details !== null &&
    typeof Reflect.get(details, 'database') === 'string' &&
    typeof Reflect.get(details, 'sqs') === 'string'
  );
}
