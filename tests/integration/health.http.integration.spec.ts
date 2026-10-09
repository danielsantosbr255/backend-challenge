import { afterEach, describe, expect, it } from 'bun:test';
import { EntityManager } from '@mikro-orm/core';
import { Module, type INestApplication, type Type } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { HealthController } from '@/modules/health/health.controller';
import { HealthService } from '@/modules/health/health.service';
import { SQS_CLIENT } from '@/infrastructure/messaging/sqs-client.provider';

const availableDatabaseCheck = async (): Promise<void> => undefined;
const unavailableDatabaseCheck = async (): Promise<void> => {
  throw new Error('private connection details');
};

const testApplications: INestApplication[] = [];

afterEach(async () => {
  await Promise.all(testApplications.splice(0).map((application) => application.close()));
});

describe('Health HTTP routes', () => {
  it('returns 200 from the public liveness route', async () => {
    const baseUrl = await startHealthServer(availableDatabaseCheck);

    const response = await fetch(`${baseUrl}/health/live`);
    const body: unknown = await response.json();

    expect(response.status).toBe(200);
    expect(isJsonObject(body)).toBe(true);

    if (!isJsonObject(body)) {
      throw new Error('Liveness response was not a JSON object');
    }

    expect(body['status']).toBe('ok');
    expect(typeof body['timestamp']).toBe('string');
  });

  it('returns 503 and a sanitized body when a dependency is unavailable', async () => {
    const baseUrl = await startHealthServer(unavailableDatabaseCheck);

    const response = await fetch(`${baseUrl}/health/ready`);
    const body: unknown = await response.json();

    expect(response.status).toBe(503);
    expect(isJsonObject(body)).toBe(true);

    if (!isJsonObject(body)) {
      throw new Error('Readiness response was not a JSON object');
    }

    expect(body['status']).toBe('error');
    expect(body['errors']).toEqual({ database: 'unavailable' });
    expect(JSON.stringify(body)).not.toContain('private connection details');
  });

  it('returns 503 and a sanitized body when SQS is unavailable', async () => {
    const baseUrl = await startHealthServer(
      availableDatabaseCheck,
      async () => {
        throw new Error('private SQS endpoint details');
      },
    );

    const response = await fetch(`${baseUrl}/health/ready`);
    const body: unknown = await response.json();

    expect(response.status).toBe(503);
    expect(isJsonObject(body)).toBe(true);

    if (!isJsonObject(body)) {
      throw new Error('Readiness response was not a JSON object');
    }

    expect(body['status']).toBe('error');
    expect(body['errors']).toEqual({ sqs: 'unavailable' });
    expect(JSON.stringify(body)).not.toContain('private SQS endpoint details');
  });
});

async function startHealthServer(
  checkDatabase: () => Promise<void>,
  sendSqsCommand: () => Promise<void> = async () => undefined,
): Promise<string> {
  const healthModule = createTestHealthModule(checkDatabase, sendSqsCommand);
  const application = await NestFactory.create(healthModule, { logger: false });
  await application.listen(0, '127.0.0.1');
  testApplications.push(application);
  return application.getUrl();
}

function createTestHealthModule(
  checkDatabase: () => Promise<void>,
  sendSqsCommand: () => Promise<void>,
): Type<unknown> {
  @Module({
    controllers: [HealthController],
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

  return TestHealthModule;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
