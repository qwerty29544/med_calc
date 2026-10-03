import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import source from '../content/source/clinical-rules.json';
import request from '../examples/evaluation-request.example.json';
import { compileAuthoring, parseExpression } from '../packages/clinical/src/compiler';
import { evaluateExpression } from '../packages/clinical/src/expression';
import { evaluate } from '../packages/clinical/src/engine';
import { validatePackage } from '../packages/clinical/src/validator';
import type { CaseDraft, FactValue, RulePackage } from '../packages/contracts/src';

const rules = () => compileAuthoring(source);
const facts = (v: Record<string, boolean | number | string | null>) =>
  Object.fromEntries(
    Object.entries(v).map(([k, value]) => [
      k,
      {
        state: value === null ? 'UNKNOWN' : 'KNOWN',
        value,
        unit: source.variables.find((f) => f.fact_code === k)?.unit ?? null,
      },
    ]),
  ) as Record<string, FactValue>;
const draft = (
  nosology_code: string,
  values: Record<string, boolean | number | string | null>,
): CaseDraft => ({
  id: 'test',
  nosology_code,
  facts: facts(values),
  medications: { state: 'KNOWN_NONE', drug_ids: [], unrecognized: [] },
});
const allFalse = Object.fromEntries(
  source.variables.map((f) => [
    f.fact_code,
    f.data_type === 'BOOLEAN'
      ? false
      : f.fact_code === 'AGE_YEARS'
        ? 40
        : f.data_type === 'ENUM'
          ? 'GOLD_I_II'
          : 0,
  ]),
);

describe('компиляция и AST', () => {
  it('связывает дозу с названием препарата, когда drug_ids заданы в ином порядке', () => {
    const p = rules();
    const options = p.treatment_options.filter((t) => t.scheme_id === 'TF_S1_R1');
    expect(options.find((t) => t.base_regimen_text.startsWith('Кларитромицин'))?.drug_id).toBe(4);
    expect(options.find((t) => t.base_regimen_text.startsWith('Азитромицин'))?.drug_id).toBe(3);
    const ceph = p.treatment_options.filter((t) => t.scheme_id === 'TF_S2_R1');
    expect(ceph.find((t) => t.base_regimen_text.startsWith('Цефуроксим'))?.drug_id).toBe(13);
    expect(ceph.find((t) => t.base_regimen_text.startsWith('Цефиксим'))?.drug_id).toBe(14);
  });
  it('компилирует шесть исходных графов в нормативную схему без изменения исходника', () => {
    const before = JSON.stringify(source);
    const p = rules();
    expect(validatePackage(p).errors).toEqual([]);
    expect(p.nosologies).toHaveLength(6);
    expect(JSON.stringify(source)).toBe(before);
    expect(p.ruleset_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(p.status).toBe('DRAFT');
  });
  it('отвергает исполняемый код и неизвестный синтаксис', () => {
    for (const s of ['process.exit()', 'A == true; alert(1)', 'x => x', 'A + 1 > 2'])
      expect(() => parseExpression(s)).toThrow();
  });
  it('сохраняет приоритет AND/OR и UNKNOWN Kleene', () => {
    const run = (s: string, v: Record<string, boolean | null>) =>
      evaluateExpression(parseExpression(s), facts(v)).value;
    expect(run('A == TRUE OR B == TRUE AND C == TRUE', { A: true, B: null, C: false })).toBe(true);
    expect(run('A == TRUE AND B == TRUE', { A: false, B: null })).toBe(false);
    expect(run('NOT (A == TRUE)', { A: null })).toBe(null);
  });
  it.each([
    [49.9, false],
    [50, false],
    [50.1, true],
  ])('граница CRP %s', (value, want) =>
    expect(evaluateExpression(parseExpression('CRP > 50'), facts({ CRP: value })).value).toBe(want),
  );
  it.each([
    ['WBC >= 12', 'WBC', 11.99, false],
    ['WBC >= 12', 'WBC', 12, true],
    ['WBC >= 12', 'WBC', 12.01, true],
    ['NEUTROPHILS_ABS >= 5.5', 'NEUTROPHILS_ABS', 5.49, false],
    ['NEUTROPHILS_ABS >= 5.5', 'NEUTROPHILS_ABS', 5.5, true],
    ['NEUTROPHILS_ABS >= 5.5', 'NEUTROPHILS_ABS', 5.51, true],
    ['BAND_NEUTROPHILS_PCT >= 10', 'BAND_NEUTROPHILS_PCT', 9.99, false],
    ['BAND_NEUTROPHILS_PCT >= 10', 'BAND_NEUTROPHILS_PCT', 10, true],
    ['BAND_NEUTROPHILS_PCT >= 10', 'BAND_NEUTROPHILS_PCT', 10.01, true],
  ] as const)('граница %s=%s %s', (s, f, v, want) =>
    expect(evaluateExpression(parseExpression(s), facts({ [f]: v })).value).toBe(want),
  );
});
describe('исполнение', () => {
  it('воспроизводит пример контракта CB_S1_R1', () => {
    const d = {
      ...draft('CHRON_BRONCHITIS', {}),
      facts: request.case_snapshot.facts as Record<string, FactValue>,
    };
    const p = rules();
    const before = JSON.stringify(d);
    const r = evaluate(p, d, { allowDraft: true });
    expect(r.status).toBe('COMPLETED');
    expect(r.outcome).toEqual({ type: 'TREATMENT_SCHEME', scheme_id: 'CB_S1_R1' });
    expect(evaluate(p, d, { allowDraft: true })).toEqual(r);
    expect(JSON.stringify(d)).toBe(before);
  });
  it('не исполняет DRAFT в штатном режиме', () =>
    expect(evaluate(rules(), draft('SINUSITIS', { SIN_SEVERE_COMPLICATED: true })).errors[0]?.code).toBe(
      'RULESET_NOT_PUBLISHED',
    ));
  it('не заменяет неизвестную мокроту значением Нет', () => {
    const r = evaluate(rules(), draft('ACUTE_BRONCHITIS', { AB_PURULENT_SPUTUM: null }), {
      allowDraft: true,
    });
    expect(r.status).toBe('NEEDS_INPUT');
    expect(r.missing_facts).toEqual(['AB_PURULENT_SPUTUM']);
  });
  it('возвращает отрицательную ветку при известном false', () =>
    expect(
      evaluate(rules(), draft('ACUTE_BRONCHITIS', { AB_PURULENT_SPUTUM: false }), { allowDraft: true })
        .outcome,
    ).toEqual({ type: 'TERMINAL_STATE', terminal_code: 'ABT_NOT_INDICATED' }));
  it('эскалация ХОБЛ имеет отдельный терминал', () =>
    expect(
      evaluate(
        rules(),
        draft('COPD_EXAC', {
          ...allFalse,
          SPUTUM_PURULENCE_INCREASE: true,
          DYSPNEA_WORSENING: true,
          COPD_GOLD_STAGE: 'GOLD_IV',
          QT_PROLONGATION: true,
        }),
        { allowDraft: true },
      ).outcome,
    ).toEqual({ type: 'TERMINAL_STATE', terminal_code: 'ESCALATE_HOSPITALIZATION' }));
  it.each([
    'CHRON_BRONCHITIS',
    'ACUTE_BRONCHITIS',
    'PNEUMONIA',
    'COPD_EXAC',
    'TONSILLOPHARYNGITIS',
    'SINUSITIS',
  ])('%s завершается на полностью известных данных', (code) => {
    const r = evaluate(rules(), draft(code, allFalse), { allowDraft: true });
    expect(r.errors).toEqual([]);
    expect(r.status).toBe('COMPLETED');
  });
  it('неизвестный элемент суммы запрашивается, не добавляет ноль', () => {
    const r = evaluate(
      rules(),
      draft('CHRON_BRONCHITIS', {
        SPUTUM_PURULENCE_INCREASE: true,
        DYSPNEA_WORSENING: false,
        SPUTUM_VOLUME_INCREASE: null,
      }),
      { allowDraft: true },
    );
    expect(r.status).toBe('NEEDS_INPUT');
    expect(r.missing_facts).toContain('SPUTUM_VOLUME_INCREASE');
  });
  it('отклоняет неправильные единицы, типы и неизвестные коды', () => {
    const p = rules();
    const d = draft('ACUTE_BRONCHITIS', { AGE_YEARS: 40 });
    d.facts.AGE_YEARS!.unit = 'mg';
    expect(evaluate(p, d, { allowDraft: true }).status).toBe('FAILED');
    d.facts = facts({ PATIENT_NAME: 'Иван' });
    expect(evaluate(p, d, { allowDraft: true }).errors[0]?.code).toBe('UNKNOWN_FACT_CODE');
  });
  it('проверяет хэш контента до выполнения', () => {
    const p = rules();
    p.nodes[0]!.output_ref = 'modified';
    expect(
      evaluate(p, draft('SINUSITIS', { SIN_SEVERE_COMPLICATED: true }), { allowDraft: true }).errors[0]?.code,
    ).toBe('RULESET_HASH_MISMATCH');
  });
  it('ограничивает число шагов', () =>
    expect(
      evaluate(rules(), draft('PNEUMONIA', allFalse), { allowDraft: true, maxSteps: 1 }).errors[0]?.code,
    ).toBe('STEP_LIMIT_EXCEEDED'));
  it.each([
    [64, 'AB_S1'],
    [65, 'AB_S2'],
    [66, 'AB_S2'],
    [79, 'AB_S2'],
    [80, 'AB_S2'],
    [81, 'AB_S2'],
  ])('границы возраста %s в остром бронхите дают %s', (age, scheme) => {
    const r = evaluate(
      rules(),
      draft('ACUTE_BRONCHITIS', {
        ...allFalse,
        AGE_YEARS: age,
        AB_PURULENT_SPUTUM: true,
        AB_CLINICAL_INTOXICATION: true,
        CRP: 51,
        HIV_AIDS: true,
      }),
      { allowDraft: true },
    );
    expect(r.outcome).toEqual({ type: 'TREATMENT_SCHEME', scheme_id: scheme });
  });
  it.each([
    [49.9, 'ABT_NOT_INDICATED'],
    [50, 'ABT_NOT_INDICATED'],
    [50.1, 'AB_S1'],
  ])('граница CRP %s влияет на конечный исход %s', (crp, want) => {
    const r = evaluate(
      rules(),
      draft('ACUTE_BRONCHITIS', {
        ...allFalse,
        AGE_YEARS: 35,
        AB_PURULENT_SPUTUM: true,
        AB_CLINICAL_INTOXICATION: true,
        CRP: crp,
      }),
      { allowDraft: true },
    );
    expect(r.outcome).toEqual(
      want === 'AB_S1'
        ? { type: 'TREATMENT_SCHEME', scheme_id: want }
        : { type: 'TERMINAL_STATE', terminal_code: want },
    );
  });
  it('на случайных известных boolean фактах детерминирован и не падает', () => {
    const p = rules();
    fc.assert(
      fc.property(fc.array(fc.boolean(), { minLength: 75, maxLength: 75 }), (bits) => {
        const v = { ...allFalse };
        source.variables.forEach((f, i) => {
          if (f.data_type === 'BOOLEAN') v[f.fact_code] = bits[i]!;
        });
        for (const n of p.nosologies) {
          const d = draft(n.nosology_code, v);
          const a = evaluate(p, d, { allowDraft: true });
          expect(a.status).toBe('COMPLETED');
          expect(evaluate(p, d, { allowDraft: true })).toEqual(a);
        }
      }),
      { numRuns: 40 },
    );
  });
});
describe('валидация графа', () => {
  it.each(['duplicate', 'cycle', 'missing', 'terminal', 'type', 'ambiguous'] as const)(
    'блокирует %s',
    (kind) => {
      const p = rules();
      delete p.ruleset_hash;
      if (kind === 'duplicate') p.nodes.push(p.nodes[0]!);
      if (kind === 'cycle') p.edges[0]!.to_node_id = p.edges[0]!.from_node_id;
      if (kind === 'missing') p.edges[0]!.to_node_id = 'NO_NODE';
      if (kind === 'terminal')
        p.edges[0]!.from_node_id = p.nodes.find((n) => n.node_type.startsWith('TERMINAL'))!.node_id;
      if (kind === 'type') p.edges[0]!.condition = parseExpression('AGE_YEARS == TRUE');
      if (kind === 'ambiguous') p.edges[1]!.condition = p.edges[0]!.condition;
      expect(validatePackage(p).valid).toBe(false);
    },
  );
});
