import { SQSClient } from '@aws-sdk/client-sqs';
import { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export const SQS_CLIENT = Symbol('SQS_CLIENT');

export const SqsClientProvider: Provider = {
  provide: SQS_CLIENT,
  inject: [ConfigService],
  useFactory: (configService: ConfigService) => {
    const region = configService.get<string>('AWS_REGION', 'us-east-1');
    const endpoint = configService.get<string>('AWS_ENDPOINT', 'http://localhost:4566');
    const accessKeyId = configService.get<string>('AWS_ACCESS_KEY_ID', 'test');
    const secretAccessKey = configService.get<string>('AWS_SECRET_ACCESS_KEY', 'test');

    return new SQSClient({
      region,
      endpoint,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });
  },
};
