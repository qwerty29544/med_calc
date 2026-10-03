import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import EmbeddedPostgres from 'embedded-postgres';
import { PostgresStore } from '../packages/db/src/postgres';
import { createApp } from '../apps/api/src/app';
import type { FastifyInstance } from 'fastify';
import type { Client } from 'pg';

describe('реальный PostgreSQL: миграции, API, неизменность и rollback', () => {
  let pg: EmbeddedPostgres, store: PostgresStore, app: FastifyInstance, client: Client;
  const origin = 'http://127.0.0.1:3000';
  let cookie = '',
    evaluationId = '';
  beforeAll(async () => {
    const port = await new Promise<number>((resolvePort) => {
      const s = createServer();
      s.listen(0, '127.0.0.1', () => {
        const address = s.address();
        const port = typeof address === 'object' && address ? address.port : 15433;
        s.close(() => resolvePort(port));
      });
    });
    const password = randomUUID();
    pg = new EmbeddedPostgres({
      databaseDir: resolve('.data', 'pg-test-' + randomUUID()),
      user: 'medcalc',
      password,
      port,
      persistent: true,
      createPostgresUser: false,
      initdbFlags: ['--encoding=UTF8', '--locale=C'],
      postgresFlags: ['-h', '127.0.0.1'],
      onLog: () => {},
      onError: () => {},
    });
    await pg.initialise();
    await pg.start();
    client = pg.getPgClient('postgres', '127.0.0.1');
    await client.connect();
    for (const name of readdirSync('packages/db/prisma/migrations').sort()) {
      if (name === 'migration_lock.toml') continue;
      await client.query(
        readFileSync(resolve('packages/db/prisma/migrations', name, 'migration.sql'), 'utf8'),
      );
    }
    store = await PostgresStore.open(`postgresql://medcalc:${password}@127.0.0.1:${port}/postgres`);
    app = await createApp({ store, demo: true });
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin },
      payload: { login: 'doctor', password: 'doctor-demo-2026' },
    });
    expect(login.statusCode).toBe(200);
    cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  }, 60000);
  afterAll(async () => {
    await app?.close();
    await store?.close();
    await client?.end();
    await pg?.stop();
  }, 30000);
  it('сохраняет evaluation и snapshot в транзакции и читает их новым подключением', async () => {
    const h = { origin, cookie };
    const c = await app.inject({
      method: 'POST',
      url: '/api/v1/cases',
      headers: h,
      payload: { nosology_code: 'ACUTE_BRONCHITIS' },
    });
    expect(c.statusCode).toBe(201);
    const id = c.json().id;
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/cases/${id}`,
      headers: h,
      payload: {
        facts: {
          AGE_YEARS: { state: 'KNOWN', value: 35, unit: 'years' },
          AB_PURULENT_SPUTUM: { state: 'KNOWN', value: false, unit: null },
        },
      },
    });
    const e = await app.inject({ method: 'POST', url: `/api/v1/cases/${id}/evaluations`, headers: h });
    expect(e.statusCode).toBe(201);
    expect(e.json().outcome).toEqual({ type: 'TERMINAL_STATE', terminal_code: 'ABT_NOT_INDICATED' });
    evaluationId = e.json().id;
    const state = await store.read();
    expect(state.evaluations).toHaveLength(1);
    expect(state.evaluations[0]?.view.snapshot?.facts.AGE_YEARS?.value).toBe(35);
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/cases/${id}`,
      headers: h,
      payload: { facts: { AGE_YEARS: { state: 'KNOWN', value: 65, unit: 'years' } } },
    });
    expect((await store.read()).evaluations[0]?.view.snapshot?.facts.AGE_YEARS?.value).toBe(35);
  });
  it('ошибка транзакции не оставляет частичных изменений', async () => {
    const n = (await store.read()).audit.length;
    await expect(
      store.transaction((s) => {
        s.audit.push({
          id: randomUUID(),
          action: 'SHOULD_ROLL_BACK',
          actor_id: null,
          resource_id: null,
          created_at: new Date().toISOString(),
          metadata: {},
        });
        throw Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect((await store.read()).audit).toHaveLength(n);
  });
  it('PostgreSQL запрещает UPDATE immutable evaluation напрямую', async () => {
    await expect(
      client.query('UPDATE evaluations SET data = $1::jsonb WHERE id = $2', [
        JSON.stringify({ changed: true }),
        evaluationId,
      ]),
    ).rejects.toThrow('immutable');
  });
  it('PostgreSQL запрещает DELETE append-only audit напрямую', async () => {
    await expect(client.query('DELETE FROM audit_events')).rejects.toThrow('immutable');
  });
});
