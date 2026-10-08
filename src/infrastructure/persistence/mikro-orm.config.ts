import { defineConfig, type Options } from '@mikro-orm/postgresql';

export const getMikroOrmConfig = (): Options =>
  defineConfig({
    host: process.env.DATABASE_HOST ?? 'localhost',
    port: Number(process.env.DATABASE_PORT ?? 5432),
    user: process.env.DATABASE_USER ?? 'postgres',
    password: process.env.DATABASE_PASSWORD ?? 'postgres',
    dbName: process.env.DATABASE_NAME ?? 'wagering_db',
    debug: process.env.NODE_ENV === 'development',
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

export default getMikroOrmConfig();
