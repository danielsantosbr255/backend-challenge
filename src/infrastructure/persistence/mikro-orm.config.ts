import { defineConfig, type Options } from '@mikro-orm/postgresql';
import type { ConfigService } from '@nestjs/config';

export const getMikroOrmConfig = (configService: ConfigService): Options =>
  defineConfig({
    host: configService.getOrThrow<string>('DATABASE_HOST'),
    port: configService.getOrThrow<number>('DATABASE_PORT'),
    user: configService.getOrThrow<string>('DATABASE_USER'),
    password: configService.getOrThrow<string>('DATABASE_PASSWORD'),
    dbName: configService.getOrThrow<string>('DATABASE_NAME'),
    debug: configService.getOrThrow<string>('NODE_ENV') === 'development',
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
