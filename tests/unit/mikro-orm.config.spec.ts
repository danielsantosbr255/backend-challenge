import { describe, expect, it } from 'bun:test';
import { mikroOrmConfig } from '@/infrastructure/persistence/mikro-orm.config';

describe('MikroORM PostgreSQL configuration', () => {
  it('uses the validated database settings from the runtime environment', () => {
    expect(mikroOrmConfig.host).toBe(process.env.DATABASE_HOST);
    expect(mikroOrmConfig.port).toBe(Number(process.env.DATABASE_PORT));
    expect(mikroOrmConfig.user).toBe(process.env.DATABASE_USER);
    expect(mikroOrmConfig.password).toBe(process.env.DATABASE_PASSWORD);
    expect(mikroOrmConfig.dbName).toBe(process.env.DATABASE_NAME);
    expect(mikroOrmConfig.debug).toBe(process.env.NODE_ENV === 'development');
  });
});
