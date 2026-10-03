import { createHash, randomBytes, scrypt, timingSafeEqual, randomUUID } from 'node:crypto';
import type { DbState, Role, Store, UserRecord } from '../../../packages/db/src/store';

export const roles = ['DOCTOR', 'CLINICAL_PHARMACOLOGIST', 'CLINICAL_ADMIN', 'SYSTEM_ADMIN'] as const;
export const digest = (text: string) => createHash('sha256').update(text).digest('hex');
export const now = () => new Date().toISOString();
export const id = () => randomUUID();
const derive = (password: string, salt: string) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
export async function hashPassword(password: string) {
  const salt = randomBytes(24).toString('hex');
  return `scrypt$32768$${salt}$${(await derive(password, salt)).toString('hex')}`;
}
export async function verifyPassword(password: string, hash: string) {
  const [algorithm, cost, salt, hex] = hash.split('$');
  if (algorithm !== 'scrypt' || cost !== '32768' || !salt || !hex) return false;
  const actual = await derive(password, salt);
  const expected = Buffer.from(hex, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export function publicUser(u: UserRecord) {
  return { id: u.id, login: u.login, name: u.name, role: u.role, active: u.active };
}
export function audit(
  state: DbState,
  action: string,
  actor_id: string | null,
  resource_id: string | null = null,
  metadata: Record<string, unknown> = {},
) {
  state.audit.push({ id: id(), action, actor_id, resource_id, metadata, created_at: now() });
}
export async function seedUsers(
  store: Store,
  demo: boolean,
  bootstrap?: { login: string; password: string; name: string },
) {
  if ((await store.read()).users.length) return;
  const accounts: { login: string; name: string; role: Role; password: string }[] = demo
    ? [
        { login: 'doctor', name: 'Демонстрационный врач', role: 'DOCTOR', password: 'doctor-demo-2026' },
        {
          login: 'clinical',
          name: 'Клинический администратор',
          role: 'CLINICAL_ADMIN',
          password: 'clinical-demo-2026',
        },
        {
          login: 'pharmacist',
          name: 'Клинический фармаколог',
          role: 'CLINICAL_PHARMACOLOGIST',
          password: 'pharmacist-demo-2026',
        },
        {
          login: 'admin',
          name: 'Системный администратор',
          role: 'SYSTEM_ADMIN',
          password: 'admin-demo-2026',
        },
      ]
    : bootstrap
      ? [{ ...bootstrap, role: 'SYSTEM_ADMIN' }]
      : [];
  if (!accounts.length)
    throw Error('Initial production user requires BOOTSTRAP_ADMIN_LOGIN and BOOTSTRAP_ADMIN_PASSWORD');
  const users = await Promise.all(
    accounts.map(async (a) => ({
      id: id(),
      login: a.login.toLowerCase(),
      name: a.name,
      role: a.role,
      password_hash: await hashPassword(a.password),
      active: true,
      created_at: now(),
    })),
  );
  await store.transaction((s) => {
    if (s.users.length) return;
    s.users.push(...users);
    audit(s, 'INITIAL_USERS', null, null, { demo, count: users.length });
  });
}
