import { SQSClient } from '@aws-sdk/client-sqs';
import { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export const SQS_CLIENT = Symbol('SQS_CLIENT');

export const SqsClientProvider: Provider = {
  provide: SQS_CLIENT,
  inject: [ConfigService],
  useFactory: (configService: ConfigService) => {
    const region = configService.getOrThrow<string>('AWS_REGION');
    const endpoint = configService.get<string>('AWS_ENDPOINT');
    const accessKeyId = configService.get<string>('AWS_ACCESS_KEY_ID');
    const secretAccessKey = configService.get<string>('AWS_SECRET_ACCESS_KEY');

    if ((accessKeyId === undefined) !== (secretAccessKey === undefined)) {
      throw new Error('Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY together');
    }

    return new SQSClient({
      region,
      ...(endpoint ? { endpoint } : {}),
      ...(accessKeyId && secretAccessKey
        ? { credentials: { accessKeyId, secretAccessKey } }
        : {}),
    });
  },
};
