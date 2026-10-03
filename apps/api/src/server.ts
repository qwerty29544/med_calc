import 'dotenv/config';
import { resolve } from 'node:path';
import { createApp } from './app';
import { DemoStore, type Store } from '../../../packages/db/src/store';

const demo = process.env.DEMO_MODE === 'true';
const production = process.env.NODE_ENV === 'production';
if (demo && production) throw Error('DEMO_MODE запрещен в production');
let store: Store;
if (process.env.DATABASE_URL) {
  const { PostgresStore } = await import('../../../packages/db/src/postgres');
  store = await PostgresStore.open(process.env.DATABASE_URL);
} else if (demo) {
  store = await DemoStore.open(resolve(process.env.DEMO_DATA_PATH ?? '.data/demo.json'), {
    demo,
    production,
  });
} else {
  throw Error('Задайте DATABASE_URL для PostgreSQL либо DEMO_MODE=true для локальной демонстрации');
}
try {
  const bootstrap =
    process.env.BOOTSTRAP_ADMIN_LOGIN && process.env.BOOTSTRAP_ADMIN_PASSWORD
      ? {
          login: process.env.BOOTSTRAP_ADMIN_LOGIN,
          password: process.env.BOOTSTRAP_ADMIN_PASSWORD,
          name: 'Системный администратор',
        }
      : undefined;
  if (bootstrap && bootstrap.password.length < 16)
    throw Error('BOOTSTRAP_ADMIN_PASSWORD должен содержать минимум 16 символов');
  const app = await createApp({
    store,
    demo,
    production,
    logger: true,
    origins: process.env.APP_ORIGIN?.split(',').map((x) => x.trim()),
    bootstrap,
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, async () => {
      await app.close();
      await store.close();
      process.exit(0);
    });
  await app.listen({ host: process.env.API_HOST ?? '127.0.0.1', port: Number(process.env.API_PORT ?? 3001) });
} catch (error) {
  await store.close();
  throw error;
}
