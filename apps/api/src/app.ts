import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import ExcelJS from 'exceljs';
import { randomBytes } from 'node:crypto';
import { z, ZodError } from 'zod';
import type { ClinicalContent, RulePackage } from '../../../packages/contracts/src';
import {
  loadContent,
  preview,
  validatePackage,
  compileAuthoring,
  formDefinition,
} from '../../../packages/clinical/src/service';
import { hashRules, canonicalJson } from '../../../packages/clinical/src/hash';
import type {
  CaseRecord,
  DbState,
  EvaluationRecord,
  PackageRecord,
  Store,
  UserRecord,
} from '../../../packages/db/src/store';
import {
  audit,
  digest,
  hashPassword,
  id,
  now,
  publicUser,
  roles,
  seedUsers,
  verifyPassword,
} from './security';
import {
  ApiError,
  draftPatch,
  evaluationInput,
  fail,
  goldenSchema,
  snapshot,
  validateFacts,
} from './validation';
import {
  isClinical,
  normalizePackage,
  overlay,
  packageHash,
  packageVersion,
  validateMedicalPackage,
} from './content';
import { registerOpenApi } from './openapi';

declare module 'fastify' {
  interface FastifyRequest {
    actor: UserRecord | null;
    sessionId: string | null;
  }
}
export interface AppOptions {
  store: Store;
  content?: ClinicalContent;
  demo: boolean;
  logger?: boolean;
  production?: boolean;
  origins?: string[];
  sessionTtlMs?: number;
  sessionIdleMs?: number;
  bootstrap?: { login: string; password: string; name: string };
}
const medicalRoles = ['DOCTOR', 'CLINICAL_PHARMACOLOGIST', 'CLINICAL_ADMIN'];
const packageRoles = ['CLINICAL_PHARMACOLOGIST', 'CLINICAL_ADMIN'];
const mutationMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const paramsId = (r: FastifyRequest) => z.strictObject({ id: z.string().uuid() }).parse(r.params).id;
const emptyBody = (r: FastifyRequest) => z.strictObject({}).parse(r.body ?? {});
function requireRole(req: FastifyRequest, allowed: readonly string[]) {
  if (!req.actor) fail(401, 'AUTH_REQUIRED', 'Необходим вход');
  if (!allowed.includes(req.actor.role)) fail(403, 'FORBIDDEN', 'Недостаточно прав');
  return req.actor;
}
function visible(actor: UserRecord, owner: string) {
  return actor.id === owner || ['CLINICAL_ADMIN', 'CLINICAL_PHARMACOLOGIST'].includes(actor.role);
}
function caseFor(s: DbState, actor: UserRecord, caseId: string, write = false) {
  const c = s.cases.find((x) => x.id === caseId);
  if (!c || !visible(actor, c.owner_id) || (write && actor.id !== c.owner_id))
    fail(404, 'CASE_NOT_FOUND', 'Случай не найден');
  return c;
}
function evaluationFor(s: DbState, actor: UserRecord, evaluationId: string) {
  const e = s.evaluations.find((x) => x.id === evaluationId);
  if (!e || !visible(actor, e.owner_id)) fail(404, 'EVALUATION_NOT_FOUND', 'Расчет не найден');
  return e;
}
function packageFor(s: DbState, packageId: string) {
  const p = s.packages.find((x) => x.id === packageId);
  if (!p) fail(404, 'CONTENT_PACKAGE_NOT_FOUND', 'Пакет не найден');
  return p;
}
function revision(s: DbState, c: CaseRecord, actor: string) {
  s.revisions.push({
    id: id(),
    case_id: c.id,
    revision: c.revision,
    created_by: actor,
    created_at: now(),
    snapshot: snapshot(c),
  });
}
function activeContent(base: ClinicalContent, s: DbState, demo: boolean, required = true): ClinicalContent {
  let content: ClinicalContent = {
    ...base,
    demo,
    ...(!demo ? { contraindications: [], interactions: [], dose_rules: [] } : {}),
  };
  const activated = new Set<string>();
  for (const type of [
    'CLINICAL_RULESET',
    'drug_registry',
    'contraindication_ruleset',
    'interaction_ruleset',
    'dose_ruleset',
  ]) {
    const active = s.activations.filter((x) => x.package_type === type).at(-1);
    if (!active) continue;
    const p = packageFor(s, active.package_id);
    if (
      p.status !== 'PUBLISHED' ||
      packageHash(p.payload) !== p.sha256 ||
      !validateMedicalPackage(p.payload, content).valid
    )
      fail(503, 'CONTENT_VALIDATION_ERROR', 'Активный пакет поврежден или несовместим');
    content = overlay(content, p.payload);
    activated.add(type);
  }
  if (required && !demo && (!activated.has('CLINICAL_RULESET') || !activated.has('drug_registry')))
    fail(
      503,
      'CONTENT_PACKAGE_NOT_PUBLISHED',
      'Требуются активные PUBLISHED клинический пакет и реестр препаратов',
    );
  return content;
}
function packageView(s: DbState, p: PackageRecord) {
  return {
    ...p,
    active: s.activations.filter((x) => x.package_type === p.package_type).at(-1)?.package_id === p.id,
  };
}
function medicalContext(base: ClinicalContent, s: DbState, demo: boolean, p: PackageRecord['payload']) {
  const current = activeContent(base, s, demo, false);
  if (isClinical(p) || p.compatibility.clinical_ruleset === current.rules.ruleset_version) return current;
  const intended = s.packages.find(
    (x) =>
      x.package_type === 'CLINICAL_RULESET' &&
      x.version === p.compatibility.clinical_ruleset &&
      x.status === 'PUBLISHED',
  );
  if (!intended) return current;
  if (
    packageHash(intended.payload) !== intended.sha256 ||
    !validateMedicalPackage(intended.payload, current).valid
  )
    fail(409, 'CONTENT_VALIDATION_ERROR', 'Целевой опубликованный граф поврежден');
  return overlay(current, intended.payload);
}
function activatePackages(s: DbState, base: ClinicalContent, demo: boolean, actor: string, ids: string[]) {
  const packages = ids.map((i) => packageFor(s, i));
  if (new Set(packages.map((p) => p.package_type)).size !== packages.length)
    fail(400, 'INPUT_VALIDATION_ERROR', 'В наборе допустима одна версия каждого типа');
  for (const p of packages) {
    if (p.status !== 'PUBLISHED' || !p.approver_id || !p.golden_report?.passed)
      fail(409, 'CONTENT_PACKAGE_NOT_PUBLISHED', 'Каждый пакет должен быть опубликован и утвержден');
    if (packageHash(p.payload) !== p.sha256)
      fail(409, 'CONTENT_VALIDATION_ERROR', 'Нарушена целостность пакета');
  }
  for (const p of packages)
    s.activations.push({
      id: id(),
      package_id: p.id,
      package_type: p.package_type,
      created_by: actor,
      created_at: now(),
    });
  try {
    activeContent(base, s, demo, false);
  } catch (error) {
    if (error instanceof ApiError)
      fail(409, error.code, 'Набор пакетов несовместим; выберите согласованные опубликованные версии');
    throw error;
  }
  for (const p of packages) audit(s, 'PACKAGE_ACTIVATED', actor, p.id, { sha256: p.sha256, bundle: ids });
  return packages.map((p) => packageView(s, p));
}

export async function createApp(options: AppOptions): Promise<FastifyInstance> {
  const { store, demo } = options;
  const production = options.production ?? process.env.NODE_ENV === 'production';
  if ((production && demo) || (store.kind === 'local-demo' && !demo))
    throw Error('Demo backend is forbidden in production');
  const base = options.content ?? loadContent();
  const initial = await store.read();
  // До первой публикации работают auth/admin; clinical endpoints остаются закрытыми.
  if (!demo && initial.activations.length) activeContent(base, initial, false, false);
  await seedUsers(store, demo, options.bootstrap);
  if (demo && !initial.packages.length)
    await store.transaction((s) => {
      if (s.packages.length) return;
      const payload = structuredClone(base.rules);
      payload.status = 'DRAFT';
      payload.ruleset_hash = hashRules(payload);
      s.packages.push({
        id: id(),
        package_type: payload.package_type,
        version: payload.ruleset_version,
        status: 'DRAFT',
        sha256: hashRules(payload),
        payload,
        created_by: null,
        created_at: now(),
      });
      audit(s, 'DEMO_CONTENT_IMPORTED', null, null, { version: payload.ruleset_version });
    });
  const origins = new Set(options.origins ?? ['http://127.0.0.1:3000', 'http://localhost:3000']);
  if (production && [...origins].some((x) => !x.startsWith('https://')))
    throw Error('Production requires HTTPS APP_ORIGIN');
  const ttl = options.sessionTtlMs ?? 8 * 60 * 60 * 1000;
  const idle = options.sessionIdleMs ?? 30 * 60 * 1000;
  const app = Fastify({
    logger: options.logger
      ? {
          level: 'info',
          redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers.set-cookie'],
          serializers: { req: (r) => ({ method: r.method, url: r.url?.split('?')[0], id: r.id }) },
        }
      : false,
    bodyLimit: 8 * 1024 * 1024,
    trustProxy: false,
  });
  await app.register(cookie);
  await app.register(rateLimit, { global: false, max: 10, timeWindow: '1 minute' });
  app.decorateRequest('actor', null);
  app.decorateRequest('sessionId', null);
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError)
      return reply.code(400).send({
        code: 'INPUT_VALIDATION_ERROR',
        message: 'Проверьте формат и допустимые поля запроса',
        details: err.issues.map((x) => ({ path: x.path.join('.'), message: x.message })),
      });
    if (err instanceof ApiError)
      return reply.code(err.statusCode).send({ code: err.code, message: err.message });
    if ((err as { statusCode?: number }).statusCode === 429)
      return reply
        .code(429)
        .send({ code: 'RATE_LIMITED', message: 'Слишком много попыток. Повторите позже.' });
    if ((err as { statusCode?: number }).statusCode === 400)
      return reply.code(400).send({ code: 'INPUT_VALIDATION_ERROR', message: 'Некорректный JSON' });
    req.log.error(
      { error_type: err instanceof Error ? err.name : 'UnknownError' },
      'Ошибка обработки запроса',
    );
    return reply
      .code(500)
      .send({ code: 'PERSISTENCE_ERROR', message: 'Операция не сохранена; повторите запрос позже' });
  });
  app.addHook('onRequest', async (req, reply) => {
    reply
      .header('Cache-Control', 'no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'no-referrer');
    if (mutationMethods.has(req.method) && (!req.headers.origin || !origins.has(req.headers.origin)))
      fail(403, 'CSRF_REJECTED', 'Недопустимый Origin');
    if (req.url.split('?')[0] === '/api/v1/auth/login' || req.url === '/api/v1/health') return;
    const token = req.cookies.med_session;
    if (!token || !/^[a-f0-9]{64}$/.test(token)) fail(401, 'AUTH_REQUIRED', 'Необходим вход');
    const sessionId = digest(token);
    const actor = await store.transaction((s) => {
      const session = s.sessions.find((x) => x.id === sessionId);
      if (!session) return null;
      const u = s.users.find((x) => x.id === session.user_id);
      if (
        !u?.active ||
        Date.parse(session.expires_at) <= Date.now() ||
        Date.parse(session.idle_expires_at) <= Date.now()
      ) {
        s.sessions = s.sessions.filter((x) => x.id !== sessionId);
        return null;
      }
      session.idle_expires_at = new Date(
        Math.min(Date.now() + idle, Date.parse(session.expires_at)),
      ).toISOString();
      return u;
    });
    if (!actor) fail(401, 'AUTH_REQUIRED', 'Сессия истекла или учетная запись заблокирована');
    req.actor = actor;
    req.sessionId = sessionId;
  });
  app.get('/api/v1/health', async () => ({ status: 'ok', demo, storage: store.kind, version: '0.1.0' }));
  app.post(
    '/api/v1/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { login, password } = z
        .strictObject({ login: z.string().trim().min(1).max(100), password: z.string().min(1).max(256) })
        .parse(req.body);
      const users = (await store.read()).users;
      const user = users.find((x) => x.login === login.toLowerCase());
      const valid = await verifyPassword(password, user?.password_hash ?? users[0]?.password_hash ?? '');
      if (!user || !user.active || !valid) {
        await store.transaction((s) => audit(s, 'LOGIN_FAILED', null, null, { ip_hash: digest(req.ip) }));
        fail(401, 'INVALID_CREDENTIALS', 'Неверный логин или пароль');
      }
      const token = randomBytes(32).toString('hex');
      await store.transaction((s) => {
        const current = s.users.find((x) => x.id === user.id);
        if (!current?.active) fail(401, 'INVALID_CREDENTIALS', 'Учетная запись заблокирована');
        s.sessions = s.sessions.filter(
          (x) => Date.parse(x.expires_at) > Date.now() && Date.parse(x.idle_expires_at) > Date.now(),
        );
        s.sessions.push({
          id: digest(token),
          user_id: user.id,
          created_at: now(),
          expires_at: new Date(Date.now() + ttl).toISOString(),
          idle_expires_at: new Date(Date.now() + Math.min(ttl, idle)).toISOString(),
        });
        audit(s, 'LOGIN', user.id);
      });
      return reply
        .setCookie('med_session', token, {
          httpOnly: true,
          secure: production,
          sameSite: 'lax',
          path: '/',
          maxAge: Math.floor(ttl / 1000),
        })
        .send({ user: publicUser(user) });
    },
  );
  app.get('/api/v1/auth/me', async (req) => ({ user: publicUser(req.actor!) }));
  app.post('/api/v1/auth/logout', async (req, reply) => {
    emptyBody(req);
    await store.transaction((s) => {
      s.sessions = s.sessions.filter((x) => x.id !== req.sessionId);
      audit(s, 'LOGOUT', req.actor!.id);
    });
    return reply.clearCookie('med_session', { path: '/' }).send({ ok: true });
  });
  app.get('/api/v1/catalog', async (req) => {
    requireRole(req, medicalRoles);
    const c = activeContent(base, await store.read(), demo);
    return {
      nosologies: c.rules.nosologies
        .filter((x) => x.active)
        .map(({ nosology_code, name_ru }) => ({ nosology_code, name_ru })),
      facts: c.rules.fact_definitions.map(formDefinition),
      demo,
      versions: { clinical_ruleset: c.rules.ruleset_version, ...c.rules.component_versions, ...c.versions },
    };
  });
  app.get('/api/v1/cases', async (req) => {
    const u = requireRole(req, medicalRoles);
    return store.transaction((s) => {
      if (u.role !== 'DOCTOR') audit(s, 'CLINICAL_LIST_ACCESS', u.id);
      return s.cases
        .filter((x) => visible(u, x.owner_id))
        .map(snapshot)
        .reverse();
    });
  });
  app.post('/api/v1/cases', async (req, reply) => {
    const u = requireRole(req, medicalRoles);
    const { nosology_code } = z.strictObject({ nosology_code: z.string().min(1).max(80) }).parse(req.body);
    const result = await store.transaction((s) => {
      const c = activeContent(base, s, demo);
      if (!c.rules.nosologies.some((x) => x.nosology_code === nosology_code && x.active))
        fail(400, 'INPUT_VALIDATION_ERROR', 'Нозология не поддерживается');
      const draft: CaseRecord = {
        id: id(),
        owner_id: u.id,
        revision: 1,
        nosology_code,
        facts: {},
        medications: { state: 'UNKNOWN', drug_ids: [], unrecognized: [] },
        created_at: now(),
        updated_at: now(),
      };
      s.cases.push(draft);
      revision(s, draft, u.id);
      audit(s, 'CASE_CREATED', u.id, draft.id);
      return snapshot(draft);
    });
    return reply.code(201).send(result);
  });
  app.get('/api/v1/cases/:id', async (req) => {
    const u = requireRole(req, medicalRoles);
    const caseId = paramsId(req);
    return store.transaction((s) => {
      const c = caseFor(s, u, caseId);
      if (c.owner_id !== u.id) audit(s, 'CLINICAL_DETAIL_ACCESS', u.id, c.id);
      return snapshot(c);
    });
  });
  app.patch('/api/v1/cases/:id', async (req) => {
    const u = requireRole(req, medicalRoles);
    const caseId = paramsId(req);
    const patch = draftPatch.parse(req.body);
    return store.transaction((s) => {
      const c = caseFor(s, u, caseId, true);
      validateFacts(activeContent(base, s, demo), patch.facts ?? {}, patch.medications);
      if (patch.facts) c.facts = { ...c.facts, ...patch.facts };
      if (patch.medications) c.medications = patch.medications;
      c.updated_at = now();
      c.revision++;
      revision(s, c, u.id);
      audit(s, 'CASE_UPDATED', u.id, c.id, { revision: c.revision });
      return snapshot(c);
    });
  });
  for (const final of [false, true])
    app.post(`/api/v1/cases/:id/${final ? 'evaluations' : 'evaluate-preview'}`, async (req, reply) => {
      const u = requireRole(req, medicalRoles);
      const caseId = paramsId(req);
      const input = final ? evaluationInput.parse(req.body ?? {}) : evaluationInput.parse(emptyBody(req));
      const result = await store.transaction((s) => {
        const draft = caseFor(s, u, caseId, true);
        if (input.feedback) {
          const previous = s.evaluations.find((e) => e.id === input.feedback!.request_id);
          if (previous) {
            const feedback = s.feedback.find((f) => f.evaluation_id === previous.id && f.user_id === u.id);
            if (previous.case_id !== caseId || previous.created_by !== u.id)
              fail(409, 'FEEDBACK_REQUEST_CONFLICT', 'Этот запрос уже использован для другого результата');
            if (
              previous.view.preview_token !== input.preview_token ||
              !feedback ||
              feedback.agreement !== input.feedback.agreement ||
              feedback.used !== input.feedback.used ||
              feedback.comment !== input.feedback.comment
            )
              fail(
                409,
                'FEEDBACK_REQUEST_CONFLICT',
                'Содержимое повторного отзыва отличается от сохранённого',
              );
            return previous.view;
          }
        }
        const content = activeContent(base, s, demo);
        validateFacts(content, draft.facts, draft.medications);
        const view = preview(content, snapshot(draft));
        view.demo = demo;
        view.preview_token = digest(canonicalJson({ revision: draft.revision, view }));
        if (!final) return view;
        if (input.preview_token && input.preview_token !== view.preview_token)
          fail(409, 'PREVIEW_CHANGED', 'Данные или правила изменились. Обновите результат перед оценкой.');
        if (input.feedback && view.status !== 'COMPLETED')
          fail(409, 'RESULT_NOT_COMPLETE', 'Оценка доступна после завершения расчёта');
        const evaluationId = input.feedback?.request_id ?? id();
        view.id = evaluationId;
        view.created_at = now();
        view.snapshot = snapshot(draft);
        view.nosology_code = draft.nosology_code;
        s.evaluations.push({
          id: evaluationId,
          case_id: draft.id,
          owner_id: draft.owner_id,
          created_by: u.id,
          case_revision: draft.revision,
          view,
        });
        audit(s, 'EVALUATION_CREATED', u.id, evaluationId, {
          case_revision: draft.revision,
          status: view.status,
        });
        if (input.feedback) {
          const { request_id: _requestId, ...feedback } = input.feedback;
          const record = {
            id: id(),
            evaluation_id: evaluationId,
            user_id: u.id,
            ...feedback,
            created_at: now(),
          };
          s.feedback.push(record);
          audit(s, 'FEEDBACK_CREATED', u.id, record.id);
        }
        return view;
      });
      return reply.code(final ? 201 : 200).send(result);
    });
  app.get('/api/v1/evaluations', async (req) => {
    const u = requireRole(req, medicalRoles);
    return store.transaction((s) => {
      if (u.role !== 'DOCTOR') audit(s, 'EVALUATION_LIST_ACCESS', u.id);
      return s.evaluations
        .filter((x) => visible(u, x.owner_id))
        .map((x) => x.view)
        .reverse();
    });
  });
  for (const section of ['', '/trace', '/explanation'])
    app.get(`/api/v1/evaluations/:id${section}`, async (req) => {
      const u = requireRole(req, medicalRoles);
      const evaluationId = paramsId(req);
      return store.transaction((s) => {
        const e = evaluationFor(s, u, evaluationId);
        if (e.owner_id !== u.id) audit(s, 'EVALUATION_DETAIL_ACCESS', u.id, e.id, { section });
        return section === '/trace' ? e.view.trace : section === '/explanation' ? e.view.explanation : e.view;
      });
    });
  app.get('/api/v1/drugs/search', async (req) => {
    requireRole(req, medicalRoles);
    const q = z
      .strictObject({ q: z.string().max(120).default('') })
      .parse(req.query)
      .q.toLocaleLowerCase('ru');
    return activeContent(base, await store.read(), demo)
      .drugs.filter((x) =>
        [x.generic_name_ru, x.normalized_code, ...x.aliases].some((name) =>
          name.toLocaleLowerCase('ru').includes(q),
        ),
      )
      .slice(0, 50);
  });
  app.get('/api/v1/drugs/:id', async (req) => {
    requireRole(req, medicalRoles);
    const drugId = z.strictObject({ id: z.coerce.number().int().positive() }).parse(req.params).id;
    return (
      activeContent(base, await store.read(), demo).drugs.find((x) => x.drug_id === drugId) ??
      fail(404, 'DRUG_NOT_FOUND', 'Препарат не найден')
    );
  });
  app.post('/api/v1/evaluations/:id/feedback', async (req, reply) => {
    const u = requireRole(req, medicalRoles);
    const evaluationId = paramsId(req);
    const input = z
      .strictObject({
        agreement: z.enum(['AGREE', 'DISAGREE']),
        used: z.boolean(),
        comment: z.string().max(2000),
      })
      .parse(req.body);
    const result = await store.transaction((s) => {
      evaluationFor(s, u, evaluationId);
      const f = { id: id(), evaluation_id: evaluationId, user_id: u.id, ...input, created_at: now() };
      s.feedback.push(f);
      audit(s, 'FEEDBACK_CREATED', u.id, f.id);
      return f;
    });
    return reply.code(201).send(result);
  });
  app.get('/api/v1/evaluations/:id/feedback', async (req) => {
    const u = requireRole(req, medicalRoles);
    const evaluationId = paramsId(req);
    return store.transaction((s) => {
      const e = evaluationFor(s, u, evaluationId);
      if (e.owner_id !== u.id) audit(s, 'FEEDBACK_ACCESS', u.id, e.id);
      return s.feedback.filter((x) => x.evaluation_id === evaluationId);
    });
  });
  app.post('/api/v1/exports/evaluations', async (req, reply) => {
    const u = requireRole(req, medicalRoles);
    const { format } = z.strictObject({ format: z.enum(['csv', 'xlsx']) }).parse(req.body);
    const data = await store.read();
    const values = data.evaluations.filter((x) => visible(u, x.owner_id));
    const headers = [
      'ID',
      'Дата',
      'Нозология',
      'Факты',
      'Исход',
      'Кандидаты',
      'Блокировки',
      'Предупреждения',
      'Дозирование',
      'Версии',
      'Хэши',
      'Обратная связь',
      'Демонстрационный режим',
    ];
    const rows = values.map((e) => exportRow(e, data));
    let buffer: Buffer;
    let mime: string;
    if (format === 'csv') {
      const safe = (value: string) => {
        const text = /^[\s]*[=+@\-\t\r]/.test(value) ? "'" + value : value;
        return '"' + text.replaceAll('"', '""') + '"';
      };
      buffer = Buffer.from(
        '\uFEFF' + [headers, ...rows].map((row) => row.map(safe).join(';')).join('\r\n'),
        'utf8',
      );
      mime = 'text/csv; charset=utf-8';
    } else {
      const book = new ExcelJS.Workbook();
      const sheet = book.addWorksheet('Расчеты');
      sheet.addRow(headers);
      for (const row of rows) sheet.addRow(row);
      sheet.getRow(1).font = { bold: true };
      sheet.views = [{ state: 'frozen', ySplit: 1 }];
      sheet.columns.forEach((c) => (c.width = 24));
      buffer = Buffer.from(await book.xlsx.writeBuffer());
      mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    }
    await store.transaction((s) => audit(s, 'EXPORT', u.id, null, { format, count: values.length }));
    return reply
      .type(mime)
      .header('Content-Disposition', `attachment; filename="evaluations.${format}"`)
      .send(buffer);
  });
  app.get('/api/v1/admin/users', async (req) => {
    requireRole(req, ['SYSTEM_ADMIN']);
    return (await store.read()).users.map(publicUser);
  });
  app.post('/api/v1/admin/users', async (req, reply) => {
    const u = requireRole(req, ['SYSTEM_ADMIN']);
    const input = z
      .strictObject({
        login: z
          .string()
          .trim()
          .min(3)
          .max(80)
          .regex(/^[a-zA-Z0-9_.-]+$/),
        name: z.string().trim().min(1).max(100),
        password: z.string().min(12).max(256),
        role: z.enum(roles),
      })
      .parse(req.body);
    const password_hash = await hashPassword(input.password);
    const result = await store.transaction((s) => {
      if (s.users.some((x) => x.login === input.login.toLowerCase()))
        fail(409, 'USER_EXISTS', 'Логин уже существует');
      const user: UserRecord = {
        id: id(),
        login: input.login.toLowerCase(),
        name: input.name,
        password_hash,
        role: input.role,
        active: true,
        created_at: now(),
      };
      s.users.push(user);
      audit(s, 'USER_CREATED', u.id, user.id, { role: user.role });
      return publicUser(user);
    });
    return reply.code(201).send(result);
  });
  app.patch('/api/v1/admin/users/:id', async (req) => {
    const u = requireRole(req, ['SYSTEM_ADMIN']);
    const userId = paramsId(req);
    const patch = z
      .strictObject({ role: z.enum(roles).optional(), active: z.boolean().optional() })
      .refine((x) => Object.keys(x).length > 0)
      .parse(req.body);
    return store.transaction((s) => {
      const target = s.users.find((x) => x.id === userId);
      if (!target) fail(404, 'USER_NOT_FOUND', 'Пользователь не найден');
      if (
        target.role === 'SYSTEM_ADMIN' &&
        target.active &&
        (patch.active === false || (patch.role && patch.role !== 'SYSTEM_ADMIN')) &&
        s.users.filter((x) => x.role === 'SYSTEM_ADMIN' && x.active).length === 1
      )
        fail(409, 'LAST_ADMIN', 'Нельзя отключить последнего системного администратора');
      Object.assign(target, patch);
      audit(s, 'USER_UPDATED', u.id, target.id, patch);
      return publicUser(target);
    });
  });
  app.get('/api/v1/admin/packages', async (req) => {
    requireRole(req, [...packageRoles, 'SYSTEM_ADMIN']);
    const s = await store.read();
    return s.packages.map((p) => packageView(s, p));
  });
  app.post('/api/v1/admin/packages/import', async (req, reply) => {
    const u = requireRole(req, packageRoles);
    const { payload } = z.strictObject({ payload: z.unknown() }).parse(req.body);
    const medical = normalizePackage(payload);
    if (!medical || !/^0\.1\.\d+$/.test(packageVersion(medical) ?? ''))
      fail(400, 'CONTENT_VALIDATION_ERROR', 'Неверные метаданные пакета');
    medical.status = 'DRAFT';
    medical.published_at = null;
    if (isClinical(medical)) medical.ruleset_hash = hashRules(medical);
    const result = await store.transaction((s) => {
      if (
        s.packages.some(
          (x) => x.package_type === medical.package_type && x.version === packageVersion(medical),
        )
      )
        fail(409, 'PACKAGE_VERSION_EXISTS', 'Создайте новую версию пакета');
      const report = validateMedicalPackage(medical, medicalContext(base, s, demo, medical));
      const p: PackageRecord = {
        id: id(),
        package_type: medical.package_type,
        version: packageVersion(medical),
        status: 'DRAFT',
        payload: medical,
        sha256: packageHash(medical),
        created_by: u.id,
        created_at: now(),
        validation_report: report,
      };
      s.packages.push(p);
      audit(s, 'PACKAGE_IMPORTED', u.id, p.id, { version: p.version, sha256: p.sha256 });
      return packageView(s, p);
    });
    return reply.code(201).send(result);
  });
  app.post('/api/v1/admin/packages/:id/validate', async (req) => {
    const u = requireRole(req, packageRoles);
    const packageId = paramsId(req);
    emptyBody(req);
    return store.transaction((s) => {
      const p = packageFor(s, packageId);
      if (['PUBLISHED', 'RETIRED'].includes(p.status))
        fail(409, 'PACKAGE_IMMUTABLE', 'Опубликованный пакет неизменяем');
      const report = validateMedicalPackage(p.payload, medicalContext(base, s, demo, p.payload));
      p.validation_report = report;
      p.status = report.valid ? 'VALIDATED' : 'IN_REVIEW';
      p.validated_at = now();
      audit(s, 'PACKAGE_VALIDATED', u.id, p.id, { valid: report.valid });
      return report;
    });
  });
  app.get('/api/v1/admin/packages/:id/validation', async (req) => {
    requireRole(req, [...packageRoles, 'SYSTEM_ADMIN']);
    return (
      packageFor(await store.read(), paramsId(req)).validation_report ?? {
        valid: false,
        errors: [{ code: 'NOT_VALIDATED', message: 'Пакет еще не проверен' }],
        warnings: [],
      }
    );
  });
  app.post('/api/v1/admin/packages/:id/publish', async (req) => {
    const u = requireRole(req, ['CLINICAL_ADMIN']);
    const packageId = paramsId(req);
    const input = z
      .strictObject({
        approval_note: z.string().trim().min(20).max(4000),
        golden_cases: z.array(goldenSchema).min(1).max(1000),
      })
      .parse(req.body);
    return store.transaction((s) => {
      const p = packageFor(s, packageId);
      if (p.status !== 'VALIDATED')
        fail(409, 'CONTENT_VALIDATION_ERROR', 'Перед публикацией необходим статус VALIDATED');
      const current = medicalContext(base, s, demo, p.payload);
      const report = validateMedicalPackage(p.payload, current);
      if (!report.valid) fail(400, 'CONTENT_VALIDATION_ERROR', 'Пакет не прошел повторную проверку');
      if (isClinical(p.payload)) {
        const unresolved = [
          ...p.payload.nodes,
          ...p.payload.edges,
          ...p.payload.schemes,
          ...p.payload.score_groups,
        ].some((x) => /PENDING|UNRESOLVED|INFERRED/.test(x.resolution_status ?? ''));
        if (unresolved)
          fail(
            409,
            'MEDICAL_APPROVAL_REQUIRED',
            'Сначала устраните неподтвержденные интерпретации источника',
          );
      }
      const candidate = { ...overlay(current, p.payload), demo: true };
      const cases = input.golden_cases.map((test) => {
        validateFacts(candidate, test.case.facts, test.case.medications);
        const result = preview(candidate, { id: 'golden', ...test.case });
        const optionsMatch = (test.expected.options ?? []).every((expected) =>
          result.options.some(
            (actual) =>
              actual.drug_id === expected.drug_id &&
              Object.entries(expected).every(
                ([key, value]) => canonicalJson(actual[key as keyof typeof actual]) === canonicalJson(value),
              ),
          ),
        );
        const passed =
          result.status === test.expected.status &&
          canonicalJson(result.outcome) === canonicalJson(test.expected.outcome) &&
          optionsMatch;
        return {
          name: test.name,
          nosology_code: test.case.nosology_code,
          passed,
          expected: test.expected,
          actual: { status: result.status, outcome: result.outcome, options: result.options },
          trace: result.trace,
        };
      });
      if (
        cases.some((x) => !x.passed) ||
        (isClinical(p.payload) &&
          p.payload.nosologies
            .filter((x) => x.active)
            .some(
              (n) =>
                !cases.some((x) => x.nosology_code === n.nosology_code && x.expected.status === 'COMPLETED'),
            ))
      )
        fail(
          400,
          'GOLDEN_CASES_FAILED',
          'Golden cases должны совпасть с ожидаемыми результатами и покрыть каждую нозологию',
        );
      if (!isClinical(p.payload)) {
        if (cases.some((x) => !x.expected.options?.length))
          fail(400, 'GOLDEN_CASES_FAILED', 'Для отдельного пакета нужны ожидаемые лекарственные варианты');
        const type = p.payload.package_type;
        const hasEffect = (o: {
          action?: string;
          drug_name?: string;
          dose_status?: string;
          regimen?: Record<string, unknown>;
        }) =>
          type === 'drug_registry'
            ? !!o.drug_name
            : type === 'dose_ruleset'
              ? o.dose_status === 'ADJUSTED' &&
                !!o.regimen &&
                (typeof o.regimen.dose_amount === 'number' ||
                  (Array.isArray(o.regimen.components) && o.regimen.components.length > 0)) &&
                typeof o.regimen.dose_unit === 'string'
              : !!o.action;
        if (cases.some((c) => c.expected.options?.some((o) => !hasEffect(o))))
          fail(
            400,
            'GOLDEN_CASES_FAILED',
            'Golden case должен явно проверять action, название препарата либо скорректированный режим дозы',
          );
        if (
          (p.payload.rules ?? [])
            .filter((r) => r.enabled)
            .some(
              (rule) =>
                !cases.some(
                  (c) =>
                    c.expected.options?.some((o) => o.drug_id === rule.drug_id && hasEffect(o)) &&
                    c.trace.some(
                      (t) =>
                        typeof t === 'object' &&
                        t !== null &&
                        'rule_id' in t &&
                        t.rule_id === rule.rule_id &&
                        'result' in t &&
                        t.result === 'TRUE',
                    ),
                ),
            )
        )
          fail(
            400,
            'GOLDEN_CASES_FAILED',
            'Golden cases должны проверить срабатывание каждого включенного правила',
          );
      }
      p.status = 'PUBLISHED';
      p.published_at = now();
      p.approver_id = u.id;
      p.approval_note = input.approval_note;
      p.golden_report = { passed: true, count: cases.length, cases };
      p.payload.status = 'PUBLISHED';
      p.payload.published_at = p.published_at;
      if (isClinical(p.payload)) p.payload.ruleset_hash = hashRules(p.payload);
      p.sha256 = packageHash(p.payload);
      audit(s, 'PACKAGE_PUBLISHED', u.id, p.id, { sha256: p.sha256, golden_count: cases.length });
      return packageView(s, p);
    });
  });
  app.post('/api/v1/admin/packages/:id/activate', async (req) => {
    const u = requireRole(req, ['CLINICAL_ADMIN']);
    const packageId = paramsId(req);
    emptyBody(req);
    return store.transaction((s) => activatePackages(s, base, demo, u.id, [packageId])[0]);
  });
  app.post('/api/v1/admin/packages/activate-set', async (req) => {
    const u = requireRole(req, ['CLINICAL_ADMIN']);
    const { package_ids } = z
      .strictObject({
        package_ids: z
          .array(z.string().uuid())
          .min(1)
          .max(5)
          .refine((v) => new Set(v).size === v.length),
      })
      .parse(req.body);
    return store.transaction((s) => activatePackages(s, base, demo, u.id, package_ids));
  });
  await registerOpenApi(app);
  return app;
}
function exportRow(e: EvaluationRecord, s: DbState): string[] {
  const v = e.view;
  return [
    e.id,
    v.created_at ?? '',
    v.nosology_code ?? '',
    JSON.stringify(v.snapshot?.facts ?? {}),
    JSON.stringify(v.outcome),
    v.options.map((x) => x.drug_name).join(', '),
    v.options
      .filter((x) => x.eligibility === 'BLOCKED')
      .map((x) => x.drug_name)
      .join(', '),
    v.warnings.join('\n'),
    v.options.map((x) => `${x.drug_name}: ${x.dose_status}`).join('\n'),
    JSON.stringify(v.versions),
    JSON.stringify(v.hashes),
    JSON.stringify(
      s.feedback
        .filter((x) => x.evaluation_id === e.id)
        .map((x) => ({ agreement: x.agreement, used: x.used, comment: x.comment })),
    ),
    String(v.demo),
  ];
}
