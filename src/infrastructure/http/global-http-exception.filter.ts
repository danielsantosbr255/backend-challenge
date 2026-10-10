import {
  Catch,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { ApplicationError } from '@/common/errors/application.error';
import { getHttpStatusForApplicationError } from './application-error-status';

type ErrorMessage = string | string[];

interface ErrorResponseBody {
  statusCode: number;
  code: string;
  message: ErrorMessage;
  timestamp: string;
}

@Catch()
@Injectable()
export class GlobalHttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalHttpExceptionFilter.name);

  constructor(private readonly httpAdapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') {
      throw exception;
    }

    const { httpAdapter } = this.httpAdapterHost;
    const context = host.switchToHttp();
    const result = toHttpErrorResponse(exception);

    if (result.statusCode >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(`Unhandled HTTP exception (${getErrorName(exception)})`);
    }

    httpAdapter.reply(context.getResponse(), {
      statusCode: result.statusCode,
      code: result.code,
      message: result.message,
      timestamp: new Date().toISOString(),
    } satisfies ErrorResponseBody, result.statusCode);
  }
}

function toHttpErrorResponse(exception: unknown): Omit<ErrorResponseBody, 'timestamp'> {
  if (exception instanceof HttpException) {
    const statusCode = exception.getStatus();
    const internalError = statusCode >= HttpStatus.INTERNAL_SERVER_ERROR;
    return {
      statusCode,
      code: internalError ? 'INTERNAL_SERVER_ERROR' : getHttpExceptionCode(statusCode),
      message: internalError ? 'Internal server error' : getHttpExceptionMessage(exception.getResponse()),
    };
  }

  if (exception instanceof ApplicationError) {
    const statusCode = getHttpStatusForApplicationError(exception);
    const isInternalError = statusCode >= HttpStatus.INTERNAL_SERVER_ERROR;
    return {
      statusCode,
      code: isInternalError ? 'INTERNAL_SERVER_ERROR' : exception.code,
      message: isInternalError ? 'Internal server error' : exception.message,
    };
  }

  return {
    statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
    code: 'INTERNAL_SERVER_ERROR',
    message: 'Internal server error',
  };
}

function getHttpExceptionCode(statusCode: number): string {
  const statusName = HttpStatus[statusCode];
  return typeof statusName === 'string' ? statusName.toUpperCase() : 'HTTP_ERROR';
}

function getHttpExceptionMessage(response: string | object): ErrorMessage {
  if (typeof response === 'string') {
    return response;
  }

  if (!('message' in response)) {
    return 'Request failed';
  }

  const { message } = response;
  if (typeof message === 'string') {
    return message;
  }

  if (Array.isArray(message) && message.every((item: unknown): item is string => typeof item === 'string')) {
    return message;
  }

  return 'Request failed';
}

function getErrorName(exception: unknown): string {
  return exception instanceof Error ? exception.name : 'UnknownError';
}
