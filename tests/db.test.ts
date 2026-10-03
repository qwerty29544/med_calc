import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DemoStore } from '../packages/db/src/store';

const opened: DemoStore[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of opened.splice(0)) await s.close();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function open() {
  const dir = await mkdtemp(join(tmpdir(), 'med-db-'));
  dirs.push(dir);
  const file = join(dir, 'db.json');
  const store = await DemoStore.open(file, { demo: true, production: false });
  opened.push(store);
  return { store, file };
}
describe('демонстрационное durable-хранилище', () => {
  it('не запускается без явного demo или в production', async () => {
    await expect(DemoStore.open('unused', { demo: false, production: false })).rejects.toThrow();
    await expect(DemoStore.open('unused', { demo: true, production: true })).rejects.toThrow();
  });
  it('переживает повторное открытие и не теряет конкурентные транзакции', async () => {
    const { store, file } = await open();
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        store.transaction((s) => {
          s.audit.push({
            id: String(i),
            action: 'TEST',
            actor_id: null,
            resource_id: null,
            created_at: new Date().toISOString(),
            metadata: {},
          });
        }),
      ),
    );
    expect((await store.read()).audit).toHaveLength(12);
    await store.close();
    opened.splice(opened.indexOf(store), 1);
    const reopened = await DemoStore.open(file, { demo: true, production: false });
    opened.push(reopened);
    expect((await reopened.read()).audit).toHaveLength(12);
    expect(JSON.parse(await readFile(file, 'utf8')).audit).toHaveLength(12);
  });
  it('откатывает неудачную транзакцию и защищает audit от перезаписи', async () => {
    const { store } = await open();
    await store.transaction((s) => {
      s.audit.push({
        id: '1',
        action: 'ORIGINAL',
        actor_id: null,
        resource_id: null,
        created_at: '2026-10-02',
        metadata: {},
      });
    });
    await expect(
      store.transaction((s) => {
        s.audit[0].action = 'MODIFIED';
      }),
    ).rejects.toThrow(/immutable/i);
    expect((await store.read()).audit[0].action).toBe('ORIGINAL');
    await expect(
      store.transaction((s) => {
        s.sessions.push({
          id: 'x',
          user_id: 'missing',
          created_at: 'x',
          expires_at: 'x',
          idle_expires_at: 'x',
        });
        throw Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect((await store.read()).sessions).toEqual([]);
  });
  it('выдает копию состояния и запрещает второму процессу открыть тот же файл', async () => {
    const { store, file } = await open();
    const snapshot = await store.read();
    snapshot.audit.push({
      id: 'leak',
      action: 'X',
      actor_id: null,
      resource_id: null,
      created_at: 'x',
      metadata: {},
    });
    expect((await store.read()).audit).toEqual([]);
    await expect(DemoStore.open(file, { demo: true, production: false })).rejects.toThrow(/already open/i);
  });
});
