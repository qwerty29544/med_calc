import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  CaseDraft,
  EvaluationView,
  RulePackage,
  ValidationReport,
  Drug,
  SafetyRule,
  DoseRule,
} from '../../contracts/src';

export type Role = 'DOCTOR' | 'CLINICAL_PHARMACOLOGIST' | 'CLINICAL_ADMIN' | 'SYSTEM_ADMIN';
export interface UserRecord {
  id: string;
  login: string;
  name: string;
  password_hash: string;
  role: Role;
  active: boolean;
  created_at: string;
}
export interface SessionRecord {
  id: string;
  user_id: string;
  created_at: string;
  expires_at: string;
  idle_expires_at: string;
}
export interface CaseRecord extends CaseDraft {
  owner_id: string;
  revision: number;
  created_at: string;
  updated_at: string;
}
export interface RevisionRecord {
  id: string;
  case_id: string;
  revision: number;
  created_by: string;
  created_at: string;
  snapshot: CaseDraft;
}
export interface EvaluationRecord {
  id: string;
  case_id: string;
  owner_id: string;
  created_by: string;
  case_revision: number;
  view: EvaluationView;
}
export interface FeedbackRecord {
  id: string;
  evaluation_id: string;
  user_id: string;
  agreement: 'AGREE' | 'DISAGREE';
  used: boolean;
  comment: string;
  created_at: string;
}
export interface AuxiliaryPackage {
  package_type: 'drug_registry' | 'contraindication_ruleset' | 'interaction_ruleset' | 'dose_ruleset';
  version: string;
  status: RulePackage['status'];
  created_at?: string;
  published_at?: string | null;
  provenance: { source: string; note?: string };
  compatibility: { clinical_ruleset: string };
  drugs?: Drug[];
  rules?: (SafetyRule | DoseRule)[];
}
export type MedicalPackage = RulePackage | AuxiliaryPackage;
export interface PackageRecord {
  id: string;
  package_type: string;
  version: string;
  status: RulePackage['status'];
  sha256: string;
  payload: MedicalPackage;
  created_by: string | null;
  created_at: string;
  validation_report?: ValidationReport;
  validated_at?: string;
  published_at?: string;
  approver_id?: string;
  approval_note?: string;
  golden_report?: { passed: boolean; count: number; cases: unknown[] };
}
export interface ActivationRecord {
  id: string;
  package_id: string;
  package_type: string;
  created_by: string;
  created_at: string;
}
export interface AuditRecord {
  id: string;
  action: string;
  actor_id: string | null;
  resource_id: string | null;
  created_at: string;
  metadata: Record<string, unknown>;
}
export interface DbState {
  schema_version: 1;
  users: UserRecord[];
  sessions: SessionRecord[];
  cases: CaseRecord[];
  revisions: RevisionRecord[];
  evaluations: EvaluationRecord[];
  feedback: FeedbackRecord[];
  packages: PackageRecord[];
  activations: ActivationRecord[];
  audit: AuditRecord[];
}
export interface Store {
  kind: 'local-demo' | 'postgresql';
  read(): Promise<DbState>;
  transaction<T>(fn: (state: DbState) => T | Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export function emptyState(): DbState {
  return {
    schema_version: 1,
    users: [],
    sessions: [],
    cases: [],
    revisions: [],
    evaluations: [],
    feedback: [],
    packages: [],
    activations: [],
    audit: [],
  };
}
export function assertInvariants(before: DbState, after: DbState) {
  for (const key of ['revisions', 'evaluations', 'feedback', 'activations', 'audit'] as const) {
    const next = new Map(after[key].map((row) => [row.id, row]));
    for (const row of before[key])
      if (JSON.stringify(next.get(row.id)) !== JSON.stringify(row))
        throw Error(`immutable ${key}: ${row.id}`);
  }
  for (const row of before.packages) {
    const next = after.packages.find((x) => x.id === row.id);
    if (
      !next ||
      ((row.status === 'PUBLISHED' || row.status === 'RETIRED') &&
        JSON.stringify(next) !== JSON.stringify(row))
    )
      throw Error(`immutable package: ${row.id}`);
  }
  for (const key of [
    'users',
    'sessions',
    'cases',
    'revisions',
    'evaluations',
    'feedback',
    'packages',
    'activations',
    'audit',
  ] as const)
    if (new Set(after[key].map((x) => x.id)).size !== after[key].length) throw Error(`Duplicate id: ${key}`);
  if (new Set(after.users.map((x) => x.login.toLowerCase())).size !== after.users.length)
    throw Error('Duplicate login');
  if (new Set(after.packages.map((x) => `${x.package_type}:${x.version}`)).size !== after.packages.length)
    throw Error('Duplicate package version');
}

/** Только один локальный процесс. Запись temp+fsync+rename; возврат после durable commit. */
export class DemoStore implements Store {
  readonly kind = 'local-demo' as const;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private constructor(
    private file: string,
    private state: DbState,
    private lock: Awaited<ReturnType<typeof open>>,
  ) {}
  static async open(file: string, options: { demo: boolean; production: boolean }): Promise<DemoStore> {
    if (!options.demo || options.production)
      throw Error('Local backend requires DEMO_MODE=true and is forbidden in production');
    file = resolve(file);
    await mkdir(dirname(file), { recursive: true });
    let lock: Awaited<ReturnType<typeof open>>;
    try {
      lock = await open(file + '.lock', 'wx', 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let alive = true;
      try {
        const pid = Number(await readFile(file + '.lock', 'utf8'));
        if (pid > 0)
          try {
            process.kill(pid, 0);
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ESRCH') alive = false;
          }
      } catch {}
      if (alive) throw Error('Database already open by another process');
      await unlink(file + '.lock');
      lock = await open(file + '.lock', 'wx', 0o600);
    }
    await lock.writeFile(String(process.pid));
    await lock.sync();
    try {
      let state = emptyState();
      try {
        state = JSON.parse(await readFile(file, 'utf8')) as DbState;
        if (state.schema_version !== 1 || !Array.isArray(state.audit))
          throw Error('Unsupported database format');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      return new DemoStore(file, state, lock);
    } catch (e) {
      await lock.close();
      await unlink(file + '.lock');
      throw e;
    }
  }
  async read() {
    await this.queue;
    if (this.closed) throw Error('Store closed');
    return structuredClone(this.state);
  }
  async transaction<T>(fn: (state: DbState) => T | Promise<T>): Promise<T> {
    const task = this.queue.then(async () => {
      if (this.closed) throw Error('Store closed');
      const next = structuredClone(this.state);
      const value = await fn(next);
      assertInvariants(this.state, next);
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify(next));
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await rename(temporary, this.file);
      } catch (e) {
        await unlink(temporary).catch(() => {});
        throw e;
      }
      this.state = next;
      return structuredClone(value);
    });
    this.queue = task.catch(() => {});
    return task;
  }
  async close() {
    await this.queue;
    if (this.closed) return;
    this.closed = true;
    await this.lock.close();
    await unlink(this.file + '.lock');
  }
}
