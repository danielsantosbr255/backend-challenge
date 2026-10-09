import { defineConfig, type Options } from '@mikro-orm/postgresql';
import { databaseEnvSchema } from '../config/env.schema';

const env = databaseEnvSchema.parse(process.env);

export const mikroOrmConfig: Options = defineConfig({
  host: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
  dbName: env.DATABASE_NAME,
  debug: env.NODE_ENV === 'development',
  entities: ['./dist/**/*.entity.js'],
  entitiesTs: ['./src/**/*.entity.ts'],
  discovery: {
    warnWhenNoEntities: false,
  },
  migrations: {
    path: './dist/infrastructure/persistence/migrations',
    pathTs: './src/infrastructure/persistence/migrations',
    tableName: 'mikro_orm_migrations',
    transactional: true,
    allOrNothing: true,
  },
  pool: {
    min: 2,
    max: 10,
  },
});
