import { z } from 'zod';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),

  // Database (PostgreSQL)
  DATABASE_HOST: z.string().min(1).default('localhost'),
  DATABASE_PORT: z.coerce.number().default(5432),
  DATABASE_USER: z.string().min(1).default('postgres'),
  DATABASE_PASSWORD: z.string().min(1).default('postgres'),
  DATABASE_NAME: z.string().min(1).default('wagering_db'),

  // AWS / LocalStack SQS
  AWS_REGION: z.string().min(1).default('us-east-1'),
  AWS_ENDPOINT: z.url().default('http://localhost:4566'),
  AWS_ACCESS_KEY_ID: z.string().min(1).default('test'),
  AWS_SECRET_ACCESS_KEY: z.string().min(1).default('test'),
  SQS_QUEUE_URL: z.url().default('http://localhost:4566/000000000000/wager-transactions.fifo'),
  SQS_DLQ_URL: z.url().default('http://localhost:4566/000000000000/wager-transactions-dlq.fifo'),
});

export type EnvConfig = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): EnvConfig {
  const result = envSchema.safeParse(config);

  if (!result.success) {
    const formattedErrors = result.error.format();
    throw new Error(
      `[EnvValidator] Configuration validation error:\n${JSON.stringify(formattedErrors, null, 2)}`,
    );
  }

  return result.data;
}
