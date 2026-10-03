import { it, expect } from 'vitest';
import { loadContent, preview } from '../packages/clinical/src/service';
import type { CaseDraft } from '../packages/contracts/src';
import request from '../examples/evaluation-request.example.json';
import type { FactValue } from '../packages/contracts/src';
const draft: CaseDraft = {
  id: 'a',
  nosology_code: 'ACUTE_BRONCHITIS',
  facts: {},
  medications: { state: 'UNKNOWN', drug_ids: [], unrecognized: [] },
};
it('первым запрашивает возраст взрослого пациента', () => {
  const r = preview(loadContent(), draft);
  expect(r.missing_facts).toEqual(['AGE_YEARS']);
  expect(r.questions[0]?.min_value).toBe(18);
});
it('не допускает педиатрический расчет', () => {
  const r = preview(loadContent(), {
    ...draft,
    facts: { AGE_YEARS: { state: 'KNOWN', value: 17, unit: 'years' } },
  });
  expect(r.status).toBe('FAILED');
});
it('не заменяет ручную проверку режимов состоянием NO_APPLICABLE_DRUG', () => {
  const r = preview(loadContent(), {
    ...draft,
    nosology_code: 'CHRON_BRONCHITIS',
    facts: request.case_snapshot.facts as Record<string, FactValue>,
  });
  expect(r.options.every((o) => o.eligibility !== 'BLOCKED')).toBe(true);
  expect(r.outcome).toEqual({ type: 'TREATMENT_SCHEME', scheme_id: 'CB_S1_R1' });
});
it('формирует воспроизводимый результат с версиями и предупреждением DRAFT', () => {
  const c = loadContent();
  const d = {
    ...draft,
    facts: {
      AGE_YEARS: { state: 'KNOWN' as const, value: 35, unit: 'years' },
      AB_PURULENT_SPUTUM: { state: 'KNOWN' as const, value: false },
    },
  };
  const r = preview(c, d);
  expect(r.status).toBe('COMPLETED');
  expect(r.demo).toBe(true);
  expect(r.title).toMatch(/не показана/);
  expect(r.versions.clinical_rules).toBe('0.1.0');
  expect(r.hashes.clinical_rules).toMatch(/^[a-f0-9]{64}$/);
  expect(r.copy_text).toContain('Демонстрационный');
  expect(preview(c, d)).toEqual(r);
});
it('копирует скорректированную дозу и предупреждения, а не прежнюю дозу', () => {
  const c = loadContent();
  c.contraindications = [
    {
      rule_id: 'test-warning',
      drug_id: 1,
      condition: { kind: 'LITERAL', value: true },
      action: 'WARN',
      message: 'Проверить синтетическое ограничение',
      source: 'test',
      enabled: true,
      validation_status: 'VALIDATED',
    },
  ];
  c.dose_rules = [
    {
      rule_id: 'test-dose',
      drug_id: 1,
      nosology_code: 'CHRON_BRONCHITIS',
      condition: { kind: 'LITERAL', value: true },
      required_facts: [],
      enabled: true,
      validation_status: 'VALIDATED',
      source: 'test',
      regimen: {
        dose_amount: 250,
        dose_unit: 'мг',
        route: 'внутрь',
        frequency_per_day: 2,
        duration_days: 7,
        source_text: 'Синтетическое правило',
        parse_status: 'STRUCTURED',
      },
    },
  ];
  const r = preview(c, {
    ...draft,
    nosology_code: 'CHRON_BRONCHITIS',
    facts: request.case_snapshot.facts as Record<string, FactValue>,
  });
  expect(r.options.find((o) => o.drug_id === 1)?.dose_status).toBe('ADJUSTED');
  expect(r.copy_text).toContain('250 мг');
  expect(r.copy_text).toContain('Проверить синтетическое ограничение');
  expect(r.copy_text).not.toContain('Амоксициллин 500 мг');
});
