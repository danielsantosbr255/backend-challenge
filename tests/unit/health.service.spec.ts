import { afterEach, describe, expect, it } from 'bun:test';
import { EntityManager } from '@mikro-orm/core';
import { Module, type INestApplicationContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { HealthService } from '@/modules/health/health.service';
import { SQS_CLIENT } from '@/infrastructure/messaging/sqs-client.provider';

const testApplications: INestApplicationContext[] = [];

afterEach(async () => {
  await Promise.all(testApplications.splice(0).map((application) => application.close()));
});

describe('HealthService', () => {
  it('reports ready when PostgreSQL and SQS are available', async () => {
    const service = await createHealthService(async () => undefined, async () => undefined);

    const result = await service.checkReadiness();

    expect(result).toEqual({
      isReady: true,
      details: { database: 'up', sqs: 'up' },
    });
  });

  it('reports PostgreSQL as unavailable without exposing its error', async () => {
    const service = await createHealthService(async () => {
      throw new Error('private database host and password');
    }, async () => undefined);

    const result = await service.checkReadiness();

    expect(result.isReady).toBe(false);
    expect(result.details).toEqual({ database: 'down', sqs: 'up' });
    expect(result.errors).toEqual({ database: 'unavailable' });
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('reports SQS as unavailable when its check fails', async () => {
    const service = await createHealthService(async () => undefined, async () => {
      throw new Error('SQS endpoint details');
    });

    const result = await service.checkReadiness();

    expect(result.isReady).toBe(false);
    expect(result.details).toEqual({ database: 'up', sqs: 'down' });
    expect(result.errors).toEqual({ sqs: 'unavailable' });
    expect(JSON.stringify(result)).not.toContain('endpoint details');
  });
});

async function createHealthService(
  checkDatabase: () => Promise<void>,
  sendSqsCommand: () => Promise<void>,
): Promise<HealthService> {
  @Module({
    providers: [
      HealthService,
      {
        provide: EntityManager,
        useValue: { getConnection: () => ({ execute: checkDatabase }) },
      },
      { provide: SQS_CLIENT, useValue: { send: sendSqsCommand } },
      {
        provide: ConfigService,
        useValue: new ConfigService({
          SQS_QUEUE_URL: 'http://localhost:4566/000000000000/wagers',
          SQS_DLQ_URL: 'http://localhost:4566/000000000000/wagers-dlq',
        }),
      },
    ],
  })
  class TestHealthModule { }

  const application = await NestFactory.createApplicationContext(
    TestHealthModule,
    { logger: false },
  );
  testApplications.push(application);
  return application.get(HealthService);
}
