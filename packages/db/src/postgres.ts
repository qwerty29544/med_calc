import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Prisma } from '../generated/client';
import { assertInvariants, emptyState, type DbState, type Store } from './store';

type Tx = Prisma.TransactionClient;
async function readState(db: Tx): Promise<DbState> {
  const [users, sessions, cases, revisions, evaluations, feedback, packages, activations, audit] =
    await Promise.all([
      db.user.findMany(),
      db.session.findMany(),
      db.clinicalCase.findMany(),
      db.caseRevision.findMany(),
      db.evaluation.findMany(),
      db.clinicianFeedback.findMany(),
      db.contentPackage.findMany(),
      db.contentPackageActivation.findMany({ orderBy: { createdAt: 'asc' } }),
      db.auditEvent.findMany({ orderBy: { createdAt: 'asc' } }),
    ]);
  const state = emptyState();
  for (const [key, rows] of Object.entries({
    users,
    sessions,
    cases,
    revisions,
    evaluations,
    feedback,
    packages,
    activations,
    audit,
  }))
    (state as unknown as Record<string, unknown>)[key] = rows.map((row) => row.data);
  return state;
}
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
/** Базовый последовательный репозиторий MVP. Запись и аудит — в одной DB-транзакции.
 * Advisory lock координирует процессы API; snapshots читаются в repeatable read.
 * Для больших историй заменить readState на адресные repository-запросы с пагинацией.
 */
export class PostgresStore implements Store {
  readonly kind = 'postgresql' as const;
  constructor(private client: PrismaClient) {}
  static async open(url: string) {
    if (!/^postgres(?:ql)?:\/\//.test(url)) throw Error('DATABASE_URL must use PostgreSQL');
    const client = new PrismaClient({
      adapter: new PrismaPg({
        connectionString: url,
        max: 10,
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 30000,
      }),
    });
    await client.$connect();
    return new PostgresStore(client);
  }
  async read() {
    return this.client.$transaction((tx) => readState(tx), { isolationLevel: 'RepeatableRead' });
  }
  async transaction<T>(fn: (s: DbState) => T | Promise<T>): Promise<T> {
    return this.client.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(742061001)`;
        const before = await readState(tx);
        const next = structuredClone(before);
        const result = await fn(next);
        assertInvariants(before, next);
        for (const u of next.users) {
          const data = { id: u.id, login: u.login, role: u.role, active: u.active, data: json(u) };
          if (!before.users.some((x) => x.id === u.id)) await tx.user.create({ data });
          else if (JSON.stringify(before.users.find((x) => x.id === u.id)) !== JSON.stringify(u))
            await tx.user.update({ where: { id: u.id }, data });
        }
        for (const c of next.cases) {
          const data = { id: c.id, ownerId: c.owner_id, revision: c.revision, data: json(c) };
          if (!before.cases.some((x) => x.id === c.id)) await tx.clinicalCase.create({ data });
          else if (JSON.stringify(before.cases.find((x) => x.id === c.id)) !== JSON.stringify(c))
            await tx.clinicalCase.update({ where: { id: c.id }, data });
        }
        for (const s of before.sessions)
          if (!next.sessions.some((x) => x.id === s.id)) await tx.session.delete({ where: { id: s.id } });
        for (const s of next.sessions) {
          const data = { id: s.id, userId: s.user_id, expiresAt: new Date(s.expires_at), data: json(s) };
          await tx.session.upsert({ where: { id: s.id }, create: data, update: data });
        }
        for (const r of next.revisions)
          if (!before.revisions.some((x) => x.id === r.id))
            await tx.caseRevision.create({
              data: {
                id: r.id,
                caseId: r.case_id,
                revision: r.revision,
                createdBy: r.created_by,
                data: json(r),
              },
            });
        for (const e of next.evaluations)
          if (!before.evaluations.some((x) => x.id === e.id))
            await tx.evaluation.create({
              data: { id: e.id, caseId: e.case_id, ownerId: e.owner_id, data: json(e) },
            });
        for (const f of next.feedback)
          if (!before.feedback.some((x) => x.id === f.id))
            await tx.clinicianFeedback.create({
              data: { id: f.id, evaluationId: f.evaluation_id, userId: f.user_id, data: json(f) },
            });
        for (const p of next.packages) {
          const data = {
            id: p.id,
            packageType: p.package_type,
            version: p.version,
            status: p.status,
            sha256: p.sha256,
            data: json(p),
          };
          if (!before.packages.some((x) => x.id === p.id)) await tx.contentPackage.create({ data });
          else if (JSON.stringify(before.packages.find((x) => x.id === p.id)) !== JSON.stringify(p))
            await tx.contentPackage.update({ where: { id: p.id }, data });
        }
        for (const a of next.activations)
          if (!before.activations.some((x) => x.id === a.id))
            await tx.contentPackageActivation.create({
              data: {
                id: a.id,
                packageId: a.package_id,
                packageType: a.package_type,
                createdAt: new Date(a.created_at),
                data: json(a),
              },
            });
        for (const a of next.audit)
          if (!before.audit.some((x) => x.id === a.id))
            await tx.auditEvent.create({
              data: {
                id: a.id,
                actorId: a.actor_id,
                action: a.action,
                createdAt: new Date(a.created_at),
                data: json(a),
              },
            });
        return structuredClone(result);
      },
      { maxWait: 10000, timeout: 30000, isolationLevel: 'ReadCommitted' },
    );
  }
  async close() {
    await this.client.$disconnect();
  }
}
