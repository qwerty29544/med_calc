import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { DemoStore } from '../packages/db/src/store';
import { createApp } from '../apps/api/src/app';
import type { ClinicalContent } from '../packages/contracts/src';
import { loadContent } from '../packages/clinical/src/service';
import example from '../examples/evaluation-request.example.json';
import { validateMedicalPackage } from '../apps/api/src/content';
import type { AuxiliaryPackage } from '../packages/db/src/store';
import type { MedicalPackage, PackageRecord } from '../packages/db/src/store';
import { packageHash, packageVersion } from '../apps/api/src/content';
import { randomUUID } from 'node:crypto';

// Проверяет API на маленьком настоящем графе; клинический движок не подменяется.
const content: ClinicalContent = {
  demo: true,
  hashes: { clinical_ruleset: 'test' },
  drugs: [
    { drug_id: 1, generic_name_ru: 'Амоксициллин', normalized_code: 'amoxicillin', aliases: ['амокс'] },
  ],
  contraindications: [],
  interactions: [],
  dose_rules: [],
  rules: {
    contract_version: '0.1.0',
    package_type: 'CLINICAL_RULESET',
    ruleset_version: '0.1.0',
    status: 'DRAFT',
    component_versions: { drug_registry: '0.1.0' },
    nosologies: [{ nosology_code: 'TEST', name_ru: 'Тест', root_node_id: 'ROOT', active: true }],
    fact_definitions: [
      {
        fact_code: 'AGE_YEARS',
        label_ru: 'Возраст пациента',
        data_type: 'INTEGER',
        unit: 'years',
        unknown_allowed: true,
        unknown_policy: 'ASK',
      },
      {
        fact_code: 'fever',
        label_ru: 'Температура',
        data_type: 'BOOLEAN',
        unknown_allowed: true,
        unknown_policy: 'ASK',
      },
      {
        fact_code: 'age',
        label_ru: 'Возраст',
        data_type: 'INTEGER',
        unit: 'years',
        min_value: 0,
        max_value: 120,
        unknown_allowed: true,
        unknown_policy: 'ASK',
      },
    ],
    score_groups: [],
    nodes: [
      {
        node_id: 'ROOT',
        nosology_code: 'TEST',
        node_type: 'TERMINAL',
        output_ref: 'ABT_NOT_INDICATED',
        resolution_status: 'CONFIRMED',
      },
    ],
    edges: [],
    schemes: [],
    terminal_states: [{ terminal_code: 'ABT_NOT_INDICATED', label_ru: 'Не показана' }],
    treatment_options: [],
    provenance: {
      source_basis: [{ source_type: 'TEST', document_id: 'fixture' }],
      normalization_policy: 'none',
    },
  },
};
let app: FastifyInstance;
let store: DemoStore;
let dir: string;
const origin = 'http://127.0.0.1:3000';
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'med-api-'));
  store = await DemoStore.open(join(dir, 'db.json'), { demo: true, production: false });
  app = await createApp({ store, content: structuredClone(content), demo: true, logger: false });
});
afterEach(async () => {
  await app?.close();
  await store?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});
async function login(name = 'doctor') {
  const r = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { origin },
    payload: { login: name, password: `${name}-demo-2026` },
  });
  expect(r.statusCode).toBe(200);
  return r.cookies[0].name + '=' + r.cookies[0].value;
}
const send = (cookie: string, method: InjectOptions['method'], url: string, payload?: unknown) =>
  app.inject({
    method,
    url: '/api/v1' + url,
    headers: { origin, cookie },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
async function create(cookie: string) {
  const r = await send(cookie, 'POST', '/cases', { nosology_code: 'TEST' });
  expect(r.statusCode).toBe(201);
  return r.json().id as string;
}
async function createReady(cookie: string) {
  const caseId = await create(cookie);
  expect(
    (
      await send(cookie, 'PATCH', `/cases/${caseId}`, {
        facts: { AGE_YEARS: { state: 'KNOWN', value: 35, unit: 'years' } },
      })
    ).statusCode,
  ).toBe(200);
  return caseId;
}
describe('HTTP API: безопасность, история и жизненный цикл', () => {
  it('сохраняет отзыв из preview вместе с точным снимком и не дублирует повтор запроса', async () => {
    const cookie = await login();
    const caseId = await createReady(cookie);
    const displayed = (await send(cookie, 'POST', `/cases/${caseId}/evaluate-preview`)).json();
    const requestId = randomUUID();
    const payload = {
      preview_token: displayed.preview_token ?? '0'.repeat(64),
      feedback: { request_id: requestId, agreement: 'DISAGREE', used: false, comment: 'Проверка результата' },
    };
    const saved = await send(cookie, 'POST', `/cases/${caseId}/evaluations`, payload);
    expect(saved.statusCode, saved.body).toBe(201);
    expect(saved.json().copy_text).toBe(displayed.copy_text);
    expect(saved.json().preview_token).toBe(displayed.preview_token);
    const repeated = await send(cookie, 'POST', `/cases/${caseId}/evaluations`, payload);
    expect(repeated.statusCode).toBe(201);
    expect(repeated.json().id).toBe(saved.json().id);
    const state = await store.read();
    expect(state.evaluations.filter((e) => e.case_id === caseId)).toHaveLength(1);
    expect(state.feedback.filter((f) => f.evaluation_id === saved.json().id)).toEqual([
      expect.objectContaining({ agreement: 'DISAGREE', comment: 'Проверка результата', used: false }),
    ]);
  });
  it('не сохраняет отзыв к preview после изменения случая', async () => {
    const cookie = await login();
    const caseId = await createReady(cookie);
    const displayed = (await send(cookie, 'POST', `/cases/${caseId}/evaluate-preview`)).json();
    await send(cookie, 'PATCH', `/cases/${caseId}`, { facts: { fever: { state: 'KNOWN', value: true } } });
    const rejected = await send(cookie, 'POST', `/cases/${caseId}/evaluations`, {
      preview_token: displayed.preview_token ?? '0'.repeat(64),
      feedback: { request_id: randomUUID(), agreement: 'AGREE', used: false, comment: '' },
    });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json().code).toBe('PREVIEW_CHANGED');
    const state = await store.read();
    expect(state.evaluations).toHaveLength(0);
    expect(state.feedback).toHaveLength(0);
  });
  it('не переиспользует ключ отзыва с другим содержанием или от другого врача', async () => {
    const cookie = await login();
    const caseId = await createReady(cookie);
    const displayed = (await send(cookie, 'POST', `/cases/${caseId}/evaluate-preview`)).json();
    const payload = {
      preview_token: displayed.preview_token ?? '0'.repeat(64),
      feedback: { request_id: randomUUID(), agreement: 'AGREE', used: false, comment: 'Первый отзыв' },
    };
    expect((await send(cookie, 'POST', `/cases/${caseId}/evaluations`, payload)).statusCode).toBe(201);
    const conflict = await send(cookie, 'POST', `/cases/${caseId}/evaluations`, {
      ...payload,
      feedback: { ...payload.feedback, agreement: 'DISAGREE' },
    });
    expect(conflict.statusCode).toBe(409);
    const other = await login('pharmacist');
    expect((await send(other, 'POST', `/cases/${caseId}/evaluations`, payload)).statusCode).toBe(404);
    expect((await store.read()).feedback).toHaveLength(1);
  });
  it('отклоняет отзыв без токена и отзыв к незавершённому расчёту без частичной записи', async () => {
    const cookie = await login();
    const caseId = await create(cookie);
    const feedback = { request_id: randomUUID(), agreement: 'AGREE', used: false, comment: '' };
    expect((await send(cookie, 'POST', `/cases/${caseId}/evaluations`, { feedback })).statusCode).toBe(400);
    const displayed = (await send(cookie, 'POST', `/cases/${caseId}/evaluate-preview`)).json();
    expect(displayed.status).toBe('NEEDS_INPUT');
    const rejected = await send(cookie, 'POST', `/cases/${caseId}/evaluations`, {
      feedback,
      preview_token: displayed.preview_token,
    });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json().code).toBe('RESULT_NOT_COMPLETE');
    const state = await store.read();
    expect(state.evaluations).toHaveLength(0);
    expect(state.feedback).toHaveLength(0);
  });
  it('принимает полностью структурированный компонентный режим без суммирования веществ', () => {
    const result = validateMedicalPackage(
      {
        package_type: 'dose_ruleset',
        version: '0.1.1',
        status: 'DRAFT',
        compatibility: { clinical_ruleset: '0.1.0' },
        provenance: { source: 'Синтетический пример комбинации' },
        rules: [
          {
            rule_id: 'combination',
            drug_id: 2,
            nosology_code: 'CHRON_BRONCHITIS',
            condition: { kind: 'LITERAL', value: true },
            required_facts: [],
            enabled: true,
            validation_status: 'VALIDATED',
            source: 'Тест',
            regimen: {
              dose_amount: null,
              dose_unit: 'мг',
              components: [
                { amount: 500, unit: 'мг' },
                { amount: 125, unit: 'мг' },
              ],
              route: 'внутрь',
              frequency_per_day: 2,
              duration_days: 7,
              source_text: 'Синтетическая комбинация',
              parse_status: 'STRUCTURED',
            },
          },
        ],
      },
      loadContent(),
    );
    expect(result.valid, JSON.stringify(result.errors)).toBe(true);
  });
  it('готовит зависимости будущего опубликованного графа и атомарно активирует согласованный набор', async () => {
    const c = await login('clinical');
    const actor = (await send(c, 'GET', '/auth/me')).json().user.id;
    const makeGraph = (version: string) => {
      const p = structuredClone(loadContent().rules);
      const terminal = p.nodes.find(
        (n) => n.node_type === 'TERMINAL_STATE' && n.output_ref === 'ABT_NOT_INDICATED',
      )!;
      p.nodes = [{ ...terminal, resolution_status: 'SOURCE_LITERAL' }];
      p.nosologies = p.nosologies
        .filter((n) => n.nosology_code === terminal.nosology_code)
        .map((n) => ({ ...n, root_node_id: terminal.node_id }));
      p.edges = [];
      p.schemes = [];
      p.treatment_options = [];
      p.score_groups = [];
      p.status = 'PUBLISHED';
      p.ruleset_version = version;
      p.component_versions.clinical_rules = version;
      p.ruleset_hash = null;
      p.ruleset_hash = packageHash(p);
      return p;
    };
    const record = (payload: MedicalPackage): PackageRecord => ({
      id: randomUUID(),
      package_type: payload.package_type,
      version: packageVersion(payload),
      status: 'PUBLISHED',
      sha256: packageHash(payload),
      payload,
      created_at: new Date().toISOString(),
      created_by: actor,
      approver_id: actor,
      approval_note: 'Синтетический готовый пакет для теста транзакции',
      golden_report: { passed: true, count: 1, cases: [] },
    });
    const oldGraph = record(makeGraph('0.1.0'));
    const future = record(makeGraph('0.1.1'));
    const oldRegistry = record({
      package_type: 'drug_registry',
      version: '0.1.0',
      status: 'PUBLISHED',
      compatibility: { clinical_ruleset: '0.1.0' },
      provenance: { source: 'synthetic fixture' },
      drugs: content.drugs,
    });
    await store.transaction((s) => {
      oldGraph.id = s.packages[0].id;
      s.packages[0] = oldGraph;
      s.packages.push(oldRegistry, future);
      s.activations.push({
        id: randomUUID(),
        package_id: oldGraph.id,
        package_type: oldGraph.package_type,
        created_by: actor,
        created_at: new Date().toISOString(),
      });
    });
    // Adapter facade сохраняет настоящие транзакции; здесь проверяется HTTP policy штатного режима.
    const productionApi = await createApp({
      store: {
        kind: 'postgresql',
        read: () => store.read(),
        transaction: (fn) => store.transaction(fn),
        close: async () => {},
      },
      content: loadContent(),
      demo: false,
      production: false,
    });
    const blocked = await productionApi.inject({ url: '/api/v1/catalog', headers: { cookie: c } });
    expect(blocked.statusCode).toBe(503);
    expect(blocked.json().code).toBe('CONTENT_PACKAGE_NOT_PUBLISHED');
    await productionApi.close();
    await store.transaction((s) => {
      s.activations.push({
        id: randomUUID(),
        package_id: oldRegistry.id,
        package_type: oldRegistry.package_type,
        created_by: actor,
        created_at: new Date().toISOString(),
      });
    });
    const imported = await send(c, 'POST', '/admin/packages/import', {
      payload: {
        package_type: 'drug_registry',
        version: '0.1.1',
        status: 'DRAFT',
        compatibility: { clinical_ruleset: '0.1.1' },
        provenance: { source: 'synthetic future registry' },
        drugs: content.drugs,
      },
    });
    expect(imported.statusCode).toBe(201);
    const registryId = imported.json().id;
    expect((await send(c, 'POST', `/admin/packages/${registryId}/validate`)).json().valid).toBe(true);
    // Публикация уже проверена отдельным тестом; здесь фиксируем подготовленные immutable записи.
    await store.transaction((s) => {
      const p = s.packages.find((x) => x.id === registryId)!;
      p.payload.status = 'PUBLISHED';
      Object.assign(p, {
        status: 'PUBLISHED',
        sha256: packageHash(p.payload),
        approver_id: actor,
        golden_report: { passed: true, count: 1, cases: [] },
      });
    });
    expect((await send(c, 'POST', `/admin/packages/${future.id}/activate`)).statusCode).toBe(409);
    expect((await store.read()).activations).toHaveLength(2);
    const activated = await send(c, 'POST', '/admin/packages/activate-set', {
      package_ids: [future.id, registryId],
    });
    expect(activated.statusCode, activated.body).toBe(200);
    const catalog = (await send(c, 'GET', '/catalog')).json();
    expect(catalog.versions.clinical_ruleset).toBe('0.1.1');
    expect(catalog.versions.drug_registry).toBe('0.1.1');
  });
  it('отдает аутентифицированную OpenAPI схему без клинического AST', async () => {
    expect((await app.inject({ url: '/api/v1/openapi.json' })).statusCode).toBe(401);
    const c = await login();
    const r = await send(c, 'GET', '/openapi.json');
    expect(r.statusCode).toBe(200);
    expect(r.json().openapi).toBe('3.0.3');
    expect(
      r.json().paths['/api/v1/cases/{id}'].patch.requestBody.content['application/json'].schema
        .additionalProperties,
    ).toBe(false);
    expect(JSON.stringify(r.json())).not.toContain('root_node_id');
  });
  it('семантический валидатор auxiliary запрещает ошибки типа, единиц, несуществующие derived и неполную дозу', () => {
    const base = loadContent();
    const meta = {
      version: '0.1.1',
      status: 'DRAFT' as const,
      provenance: { source: 'test' },
      compatibility: { clinical_ruleset: '0.1.0' },
    };
    const rule = {
      rule_id: 'r',
      drug_id: 1,
      action: 'BLOCK' as const,
      message: 'test',
      source: 'test',
      enabled: true,
      validation_status: 'VALIDATED',
    };
    for (const condition of [
      {
        kind: 'OP',
        operator: 'GT',
        operands: [
          { kind: 'REF', ref_type: 'FACT', ref_id: 'DIABETES' },
          { kind: 'LITERAL', value: 1 },
        ],
      },
      {
        kind: 'OP',
        operator: 'GT',
        operands: [
          { kind: 'REF', ref_type: 'FACT', ref_id: 'AGE_YEARS' },
          { kind: 'LITERAL', value: 20, unit: 'kg' },
        ],
      },
      {
        kind: 'OP',
        operator: 'GT',
        operands: [
          { kind: 'REF', ref_type: 'DERIVED_FACT', ref_id: 'CRCL_CG' },
          { kind: 'LITERAL', value: 20 },
        ],
      },
    ])
      expect(
        validateMedicalPackage(
          {
            ...meta,
            package_type: 'contraindication_ruleset',
            rules: [{ ...rule, condition }],
          } as AuxiliaryPackage,
          base,
        ).valid,
      ).toBe(false);
    expect(
      validateMedicalPackage(
        {
          ...meta,
          package_type: 'dose_ruleset',
          rules: [
            {
              rule_id: 'dose',
              drug_id: 1,
              nosology_code: 'CHRON_BRONCHITIS',
              condition: { kind: 'LITERAL', value: true },
              required_facts: [],
              enabled: true,
              validation_status: 'VALIDATED',
              source: 'test',
              regimen: {
                dose_amount: null,
                dose_unit: null,
                route: null,
                frequency_per_day: null,
                duration_days: null,
                parse_status: 'STRUCTURED',
                source_text: 'test',
              },
            },
          ],
        },
        base,
      ).valid,
    ).toBe(false);
    const drugs = structuredClone(base.drugs);
    drugs[0].normalized_code = 'OTHER_SUBSTANCE';
    expect(validateMedicalPackage({ ...meta, package_type: 'drug_registry', drugs }, base).valid).toBe(false);
  });
  it('требует сессию и отклоняет посторонний Origin', async () => {
    expect((await app.inject({ url: '/api/v1/cases' })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          headers: { origin: 'https://attacker.example' },
          payload: { login: 'doctor', password: 'doctor-demo-2026' },
        })
      ).statusCode,
    ).toBe(403);
  });
  it('создает HttpOnly cookie, прячет хэши паролей и проверяет logout', async () => {
    const cookie = await login();
    const me = await send(cookie, 'GET', '/auth/me');
    expect(me.json().user).toMatchObject({ role: 'DOCTOR', login: 'doctor' });
    expect(me.json().user.password_hash).toBeUndefined();
    await send(cookie, 'POST', '/auth/logout');
    expect((await send(cookie, 'GET', '/auth/me')).statusCode).toBe(401);
  });
  it('блокирует brute force входа', async () => {
    for (let i = 0; i < 10; i++)
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { origin },
        payload: { login: 'doctor', password: 'invalid-password' },
      });
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin },
      payload: { login: 'doctor', password: 'invalid-password' },
    });
    expect(r.statusCode).toBe(429);
  });
  it('не принимает неизвестные ключи, неверные единицы и неявные значения UNKNOWN', async () => {
    const c = await login();
    const id = await create(c);
    for (const patch of [
      { patient_name: 'Петров' },
      { facts: { unknown_fact: { state: 'KNOWN', value: true } } },
      { facts: { fever: { state: 'UNKNOWN', value: false } } },
      { facts: { age: { state: 'KNOWN', value: 30, unit: 'kg' } } },
      { facts: { age: { state: 'KNOWN', value: -1 } } },
      { medications: { state: 'KNOWN_NONE', drug_ids: [1], unrecognized: [] } },
    ])
      expect((await send(c, 'PATCH', `/cases/${id}`, patch)).statusCode).toBe(400);
  });
  it('сохраняет редакции и неизменный snapshot после изменения черновика', async () => {
    const c = await login();
    const id = await create(c);
    await send(c, 'PATCH', `/cases/${id}`, { facts: { fever: { state: 'KNOWN', value: true } } });
    const evaluation = await send(c, 'POST', `/cases/${id}/evaluations`);
    expect(evaluation.statusCode).toBe(201);
    const value = evaluation.json();
    expect(value.id).toBeTruthy();
    expect(value.demo).toBe(true);
    await send(c, 'PATCH', `/cases/${id}`, { facts: { fever: { state: 'KNOWN', value: false } } });
    const history = await send(c, 'GET', `/evaluations/${value.id}`);
    expect(history.json()).toEqual(value);
    expect((await store.read()).revisions).toHaveLength(3);
    expect(value.snapshot.facts.fever.value).toBe(true);
  });
  it('preview совпадает с финальным pipeline и не создает history', async () => {
    const c = await login();
    const id = await create(c);
    const a = (await send(c, 'POST', `/cases/${id}/evaluate-preview`)).json();
    expect((await send(c, 'GET', '/evaluations')).json()).toHaveLength(0);
    const b = (await send(c, 'POST', `/cases/${id}/evaluations`)).json();
    for (const key of ['status', 'outcome', 'options', 'trace', 'versions', 'hashes'])
      expect(a[key]).toEqual(b[key]);
  });
  it('проверяет owner и не выдает clinical records системному администратору', async () => {
    const doctor = await login();
    const admin = await login('admin');
    const id = await create(doctor);
    const r = await send(admin, 'POST', '/admin/users', {
      login: 'doctor2',
      password: 'doctor2-password',
      name: 'Второй врач',
      role: 'DOCTOR',
    });
    expect(r.statusCode).toBe(201);
    const l = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin },
      payload: { login: 'doctor2', password: 'doctor2-password' },
    });
    const other = l.cookies[0].name + '=' + l.cookies[0].value;
    expect((await send(other, 'GET', `/cases/${id}`)).statusCode).toBe(404);
    expect((await send(admin, 'GET', `/cases/${id}`)).statusCode).toBe(403);
  });
  it('изменение роли и блокировка действуют на существующую сессию', async () => {
    const doctor = await login();
    const admin = await login('admin');
    const me = (await send(doctor, 'GET', '/auth/me')).json().user;
    expect((await send(doctor, 'GET', '/admin/users')).statusCode).toBe(403);
    await send(admin, 'PATCH', `/admin/users/${me.id}`, { active: false });
    expect((await send(doctor, 'GET', '/auth/me')).statusCode).toBe(401);
  });
  it('сессии имеют idle и absolute expiration', async () => {
    const c = await login();
    await store.transaction((s) => {
      s.sessions[0].idle_expires_at = '2000-01-01T00:00:00.000Z';
    });
    expect((await send(c, 'GET', '/cases')).statusCode).toBe(401);
  });
  it('DRAFT не активируется, SYSTEM_ADMIN не может публиковать', async () => {
    const clinical = await login('clinical');
    const admin = await login('admin');
    const packages = (await send(clinical, 'GET', '/admin/packages')).json();
    expect(packages[0].status).toBe('DRAFT');
    expect(packages[0].active).toBe(false);
    expect((await send(clinical, 'POST', `/admin/packages/${packages[0].id}/activate`)).statusCode).toBe(409);
    expect(
      (
        await send(admin, 'POST', `/admin/packages/${packages[0].id}/publish`, {
          approval_note: 'Медицинское утверждение для проверки',
          golden_cases: [],
        })
      ).statusCode,
    ).toBe(403);
  });
  it('сохраняет feedback и создает оба экспорта', async () => {
    const c = await login();
    const id = await create(c);
    const e = (await send(c, 'POST', `/cases/${id}/evaluations`)).json();
    expect(
      (
        await send(c, 'POST', `/evaluations/${e.id}/feedback`, {
          agreement: 'DISAGREE',
          used: false,
          comment: '=1+1',
        })
      ).statusCode,
    ).toBe(201);
    expect((await send(c, 'GET', `/evaluations/${e.id}/feedback`)).json()).toHaveLength(1);
    const csv = await send(c, 'POST', '/exports/evaluations', { format: 'csv' });
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body).toContain(e.id);
    const xlsx = await send(c, 'POST', '/exports/evaluations', { format: 'xlsx' });
    expect(xlsx.rawPayload.subarray(0, 2).toString()).toBe('PK');
    expect((await store.read()).audit.filter((x) => x.action === 'EXPORT')).toHaveLength(2);
  });
  it('не открывает клинический DRAFT вне демонстрационного режима', async () => {
    await expect(
      createApp({ store, content: structuredClone(content), demo: false, logger: false }),
    ).rejects.toThrow(/Demo backend/);
  });
  it('отклоняет несовпадающие golden cases и сохраняет опубликованный пакет неизменным', async () => {
    const c = await login('clinical');
    const p = structuredClone(loadContent().rules);
    const terminal = p.nodes.find(
      (n) => n.node_type === 'TERMINAL_STATE' && n.output_ref === 'ABT_NOT_INDICATED',
    )!;
    p.nodes = [{ ...terminal, resolution_status: 'SOURCE_LITERAL' }];
    p.nosologies = p.nosologies
      .filter((n) => n.nosology_code === terminal.nosology_code)
      .map((n) => ({ ...n, root_node_id: terminal.node_id }));
    p.edges = [];
    p.schemes = [];
    p.treatment_options = [];
    p.score_groups = [];
    p.ruleset_version = '0.1.1';
    p.component_versions.clinical_rules = '0.1.1';
    p.ruleset_hash = null;
    const imported = await send(c, 'POST', '/admin/packages/import', { payload: p });
    expect(imported.statusCode).toBe(201);
    const packageId = imported.json().id;
    expect((await send(c, 'POST', `/admin/packages/${packageId}/validate`)).json().valid).toBe(true);
    const golden = {
      name: 'Терминальное состояние',
      case: {
        nosology_code: terminal.nosology_code,
        facts: { AGE_YEARS: { state: 'KNOWN', value: 40, unit: 'years' } },
        medications: { state: 'KNOWN_NONE', drug_ids: [], unrecognized: [] },
      },
      expected: {
        status: 'COMPLETED',
        outcome: { type: 'TERMINAL_STATE', terminal_code: 'ABT_NOT_INDICATED' },
      },
    };
    const bad = structuredClone(golden);
    bad.expected.outcome.terminal_code = 'ESCALATE_HOSPITALIZATION';
    expect(
      (
        await send(c, 'POST', `/admin/packages/${packageId}/publish`, {
          approval_note: 'Проверено клиническим администратором на тестовых данных',
          golden_cases: [bad],
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await send(c, 'POST', `/admin/packages/${packageId}/publish`, {
          approval_note: 'Проверено клиническим администратором на тестовых данных',
          golden_cases: [golden],
        })
      ).statusCode,
    ).toBe(200);
    expect((await send(c, 'POST', `/admin/packages/${packageId}/activate`)).statusCode).toBe(200);
    await expect(
      store.transaction((s) => {
        s.packages.find((x) => x.id === packageId)!.sha256 = 'changed';
      }),
    ).rejects.toThrow(/immutable/);
  });
  it('принимает отдельный реестр препаратов, но не публикует MOCK safety-правило', async () => {
    const c = await login('clinical');
    const registry = {
      package_type: 'drug_registry',
      version: '0.1.1',
      status: 'DRAFT',
      provenance: { source: 'Тестовый справочник' },
      compatibility: { clinical_ruleset: '0.1.0' },
      drugs: content.drugs,
    };
    const imported = await send(c, 'POST', '/admin/packages/import', { payload: registry });
    expect(imported.statusCode).toBe(201);
    expect((await send(c, 'POST', `/admin/packages/${imported.json().id}/validate`)).json().valid).toBe(true);
    const mock = {
      package_type: 'contraindication_ruleset',
      version: '0.1.1',
      status: 'DRAFT',
      provenance: { source: 'Тест' },
      compatibility: { clinical_ruleset: '0.1.0' },
      rules: [
        {
          rule_id: 'MOCK',
          drug_id: 1,
          condition: { kind: 'LITERAL', value: true },
          action: 'BLOCK',
          message: 'Mock',
          source: 'MOCK',
          enabled: true,
          validation_status: 'MOCK_EXAMPLE',
        },
      ],
    };
    const r = await send(c, 'POST', '/admin/packages/import', { payload: mock });
    expect(r.statusCode).toBe(201);
    expect((await send(c, 'POST', `/admin/packages/${r.json().id}/validate`)).json().valid).toBe(false);
  });
  it('публикация safety требует проверяемого эффекта golden case и активация меняет результат', async () => {
    await app.close();
    app = await createApp({ store, content: loadContent(), demo: true });
    const c = await login('clinical');
    const payload = {
      package_type: 'contraindication_ruleset',
      version: '0.1.1',
      status: 'DRAFT',
      provenance: { source: 'Синтетический API test' },
      compatibility: { clinical_ruleset: '0.1.0' },
      rules: [
        {
          rule_id: 'API-BLOCK',
          drug_id: 1,
          condition: { kind: 'LITERAL', value: true },
          action: 'BLOCK',
          message: 'Синтетическое проверяемое предупреждение',
          source: 'API test',
          enabled: true,
          validation_status: 'VALIDATED',
        },
      ],
    };
    const imported = await send(c, 'POST', '/admin/packages/import', { payload });
    expect(imported.statusCode).toBe(201);
    const packageId = imported.json().id;
    expect((await send(c, 'POST', `/admin/packages/${packageId}/validate`)).json().valid).toBe(true);
    const golden = {
      name: 'Подтвержденный эффект BLOCK',
      case: {
        nosology_code: 'CHRON_BRONCHITIS',
        facts: Object.fromEntries(
          Object.entries(example.case_snapshot.facts).map(([k, { observed_at, ...v }]) => [k, v]),
        ),
        medications: { state: 'KNOWN_NONE', drug_ids: [], unrecognized: [] },
      },
      expected: {
        status: 'COMPLETED',
        outcome: { type: 'TREATMENT_SCHEME', scheme_id: 'CB_S1_R1' },
        options: [{ drug_id: 1, action: 'BLOCK' }],
      },
    };
    const noEffect = { ...golden, expected: { ...golden.expected, options: [{ drug_id: 1 }] } };
    expect(
      (
        await send(c, 'POST', '/admin/packages/' + packageId + '/publish', {
          approval_note: 'Синтетическое тестовое медицинское подтверждение',
          golden_cases: [noEffect],
        })
      ).statusCode,
    ).toBe(400);
    const published = await send(c, 'POST', `/admin/packages/${packageId}/publish`, {
      approval_note: 'Синтетическое тестовое медицинское подтверждение',
      golden_cases: [golden],
    });
    expect(published.statusCode, published.body).toBe(200);
    expect((await send(c, 'POST', `/admin/packages/${packageId}/activate`)).statusCode).toBe(200);
    const doctor = await login();
    const created = await send(doctor, 'POST', '/cases', { nosology_code: 'CHRON_BRONCHITIS' });
    const caseId = created.json().id;
    expect(
      (
        await send(doctor, 'PATCH', `/cases/${caseId}`, {
          facts: Object.fromEntries(
            Object.entries(example.case_snapshot.facts).map(([k, { observed_at, ...v }]) => [k, v]),
          ),
          medications: golden.case.medications,
        })
      ).statusCode,
    ).toBe(200);
    const result = (await send(doctor, 'POST', `/cases/${caseId}/evaluations`)).json();
    expect(result.options.find((o: { drug_id: number }) => o.drug_id === 1).action).toBe('BLOCK');
    expect(result.versions.contraindications).toBe('0.1.1');
    expect(result.hashes.contraindications).toBe(published.json().sha256);
  });
  it('поиск препаратов использует активированную версию справочника', async () => {
    await app.close();
    const base = loadContent();
    app = await createApp({ store, content: base, demo: true });
    const c = await login('clinical');
    const drugs = structuredClone(base.drugs);
    drugs.find((d) => d.drug_id === 1)!.aliases.push('REGISTRY_ACTIVATED_TEST');
    const payload = {
      package_type: 'drug_registry',
      version: '0.1.1',
      status: 'DRAFT',
      provenance: { source: 'Синтетический реестр' },
      compatibility: { clinical_ruleset: '0.1.0' },
      drugs,
    };
    const imported = await send(c, 'POST', '/admin/packages/import', { payload });
    const packageId = imported.json().id;
    expect((await send(c, 'POST', `/admin/packages/${packageId}/validate`)).json().valid).toBe(true);
    const golden = {
      name: 'Название из справочника',
      case: {
        nosology_code: 'CHRON_BRONCHITIS',
        facts: Object.fromEntries(
          Object.entries(example.case_snapshot.facts).map(([k, { observed_at, ...v }]) => [k, v]),
        ),
        medications: { state: 'KNOWN_NONE', drug_ids: [], unrecognized: [] },
      },
      expected: {
        status: 'COMPLETED',
        outcome: { type: 'TREATMENT_SCHEME', scheme_id: 'CB_S1_R1' },
        options: [{ drug_id: 1, drug_name: 'Амоксициллин' }],
      },
    };
    expect(
      (
        await send(c, 'POST', `/admin/packages/${packageId}/publish`, {
          approval_note: 'Синтетический реестр проверен для интеграционного теста',
          golden_cases: [golden],
        })
      ).statusCode,
    ).toBe(200);
    expect((await send(c, 'POST', `/admin/packages/${packageId}/activate`)).statusCode).toBe(200);
    const doctor = await login();
    expect(
      (await send(doctor, 'GET', '/drugs/search?q=REGISTRY_ACTIVATED_TEST'))
        .json()
        .map((x: { drug_id: number }) => x.drug_id),
    ).toEqual([1]);
  });
});
