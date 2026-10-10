import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  BadRequestException,
  Controller,
  Get,
  Module,
  type INestApplication,
} from '@nestjs/common';
import { APP_FILTER, NestFactory } from '@nestjs/core';
import { WalletAlreadyExistsError } from '@/modules/wallet/wallet.errors';
import { GlobalHttpExceptionFilter } from '@/infrastructure/http/global-http-exception.filter';

let testApp: INestApplication;
let testBaseUrl: string;

@Controller('errors')
class ExceptionFilterTestController {
  @Get('application')
  throwApplicationError(): never {
    throw new WalletAlreadyExistsError();
  }

  @Get('http')
  throwHttpException(): never {
    throw new BadRequestException('Invalid input');
  }

  @Get('unexpected')
  throwUnexpectedError(): never {
    throw new Error('Private infrastructure details');
  }
}

@Module({
  controllers: [ExceptionFilterTestController],
  providers: [{ provide: APP_FILTER, useClass: GlobalHttpExceptionFilter }],
})
class ExceptionFilterTestModule {}

describe('Global HTTP exception filter', () => {
  beforeAll(async () => {
    testApp = await NestFactory.create(ExceptionFilterTestModule, { logger: false });
    await testApp.listen(0, '127.0.0.1');
    testBaseUrl = await testApp.getUrl();
  });

  afterAll(async () => {
    await testApp?.close();
  });

  it('maps application errors to their status and stable code', async () => {
    const response = await fetch(`${testBaseUrl}/errors/application`);
    const body: unknown = await response.json();

    expect(response.status).toBe(409);
    expect(isJsonObject(body)).toBe(true);
    if (isJsonObject(body)) {
      expect(body['code']).toBe('WALLET_ALREADY_EXISTS');
      expect(body['message']).toBe('A wallet already exists for this player and currency');
    }
  });

  it('preserves standard NestJS HTTP exception statuses and messages', async () => {
    const response = await fetch(`${testBaseUrl}/errors/http`);
    const body: unknown = await response.json();

    expect(response.status).toBe(400);
    expect(isJsonObject(body)).toBe(true);
    if (isJsonObject(body)) {
      expect(body['code']).toBe('BAD_REQUEST');
      expect(body['message']).toBe('Invalid input');
    }
  });

  it('returns a generic response for unexpected errors without leaking their message', async () => {
    const response = await fetch(`${testBaseUrl}/errors/unexpected`);
    const body: unknown = await response.json();

    expect(response.status).toBe(500);
    expect(isJsonObject(body)).toBe(true);
    if (isJsonObject(body)) {
      expect(body['code']).toBe('INTERNAL_SERVER_ERROR');
      expect(body['message']).toBe('Internal server error');
      expect(JSON.stringify(body)).not.toContain('Private infrastructure details');
    }
  });
});

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
