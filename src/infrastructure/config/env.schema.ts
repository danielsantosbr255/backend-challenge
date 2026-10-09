import { z } from 'zod';

const tcpPortSchema = z.coerce.number().int().min(1).max(65535);

const baseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  PORT: tcpPortSchema,

  // Database (PostgreSQL)
  DATABASE_HOST: z.string().min(1),
  DATABASE_PORT: tcpPortSchema,
  DATABASE_USER: z.string().min(1),
  DATABASE_PASSWORD: z.string().min(1),
  DATABASE_NAME: z.string().min(1),

  // AWS / LocalStack SQS
  AWS_REGION: z.string().min(1),
  AWS_ENDPOINT: z.url().optional(),
  AWS_ACCESS_KEY_ID: z.string().min(1).optional(),
  AWS_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  SQS_QUEUE_URL: z.url(),
  SQS_DLQ_URL: z.url(),
});

export const databaseEnvSchema = baseEnvSchema.pick({
  NODE_ENV: true,
  DATABASE_HOST: true,
  DATABASE_PORT: true,
  DATABASE_USER: true,
  DATABASE_PASSWORD: true,
  DATABASE_NAME: true,
});

export const envSchema = baseEnvSchema.refine(
  ({ AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY }) =>
    (AWS_ACCESS_KEY_ID === undefined) === (AWS_SECRET_ACCESS_KEY === undefined),
  {
    message: 'Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY together',
    path: ['AWS_ACCESS_KEY_ID'],
  },
);

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
