import { describe, expect, it } from 'vitest';
import type {
  CaseDraft,
  ClinicalContent,
  DoseRule,
  Regimen,
  RulePackage,
  SafetyRule,
} from '../packages/contracts/src/index.ts';
import { parseRegimen, resolveTherapy } from '../packages/therapy/src/index.ts';

const baseText = 'Препарат 500 мг внутрь 2 раза в сутки курсом 7 дней';
const baseRegimen: Regimen = {
  dose_amount: 500,
  dose_unit: 'мг',
  route: 'внутрь',
  frequency_per_day: 2,
  duration_days: 7,
  source_text: baseText,
  parse_status: 'STRUCTURED',
};
const fact = (
  value: boolean | number | string | null,
  state: 'KNOWN' | 'UNKNOWN' | 'NOT_ASSESSED' = 'KNOWN',
) => ({ state, value });
const draft = (updates: Partial<CaseDraft> = {}): CaseDraft => ({
  id: 'case',
  nosology_code: 'TEST',
  facts: {},
  medications: { state: 'KNOWN_NONE', drug_ids: [], unrecognized: [] },
  ...updates,
});
function content(updates: Partial<ClinicalContent> = {}): ClinicalContent {
  const rules: RulePackage = {
    contract_version: '0.1.0',
    package_type: 'CLINICAL_RULESET',
    ruleset_version: 'test',
    status: 'DRAFT',
    component_versions: {},
    nosologies: [{ nosology_code: 'TEST', name_ru: 'Тест', root_node_id: 'root', active: true }],
    fact_definitions: [],
    score_groups: [],
    nodes: [],
    edges: [],
    terminal_states: [],
    schemes: [{ scheme_id: 'S', nosology_code: 'TEST', scheme_root: 'S', resolution_status: 'RESOLVED' }],
    treatment_options: [
      {
        treatment_option_id: 'O',
        scheme_id: 'S',
        line_type: 'FIRST_LINE',
        option_group: 1,
        drug_id: 1,
        base_regimen_text: baseText,
      },
    ],
    provenance: {
      source_basis: [{ source_type: 'SYNTHETIC', document_id: 'therapy-test' }],
      normalization_policy: 'NONE',
    },
  };
  return {
    rules,
    drugs: [{ drug_id: 1, generic_name_ru: 'Тестовый препарат', normalized_code: 'TEST', aliases: [] }],
    contraindications: [],
    interactions: [],
    dose_rules: [],
    hashes: {},
    demo: true,
    ...updates,
  };
}
const safety = (action: SafetyRule['action'], updates: Partial<SafetyRule> = {}): SafetyRule => ({
  rule_id: `rule-${action}`,
  drug_id: 1,
  condition: { kind: 'LITERAL', value: true },
  action,
  message: `Тест ${action}`,
  source: 'Синтетический fixture',
  enabled: true,
  validation_status: 'VALIDATED',
  ...updates,
});
const dose = (updates: Partial<DoseRule> = {}): DoseRule => ({
  rule_id: 'dose-test',
  drug_id: 1,
  nosology_code: 'TEST',
  condition: { kind: 'LITERAL', value: true },
  required_facts: [],
  regimen: { ...baseRegimen, dose_amount: 250, source_text: 'Синтетическая корректировка' },
  enabled: true,
  validation_status: 'VALIDATED',
  source: 'Синтетический fixture',
  ...updates,
});

describe('parseRegimen: точность переноса исходного текста', () => {
  it('умножает силу таблетки на число таблеток в разовом приёме', () => {
    const result = parseRegimen('Амоксициллин 500 мг по 2 таблетки 3 раза в сутки курсом 7 дней');
    expect(result).toMatchObject({
      dose_amount: 1000,
      dose_unit: 'мг',
      frequency_per_day: 3,
      duration_days: 7,
    });
  });
  it('сохраняет исходную опечатку при техническом распознавании числа таблеток', () => {
    const text = 'Амоксициллин 500 мг по 2 таблеткb 3 раза в сутки курсом 7 дней';
    expect(parseRegimen(text)).toMatchObject({ dose_amount: 1000, source_text: text });
  });
  it('сохраняет раздельные количества компонентов комбинации', () => {
    const result = parseRegimen(
      'Амоксициллин + клавулановая кислота 875 мг +125 мг по 1 таблетке 2 раза в сутки курсом 7 дней',
    );
    expect(result).toMatchObject({
      dose_amount: null,
      components: [
        { amount: 875, unit: 'мг' },
        { amount: 125, unit: 'мг' },
      ],
      frequency_per_day: 2,
    });
  });
  it('разделяет альтернативные дозы того же препарата без выбора одной из них', () => {
    const result = parseRegimen(
      'Цефиксим 200 мг 2 раза в сутки или 400 мг 1 раз в сутки внутрь. Длительность терапии – 10 дней',
    );
    expect(result.dose_amount).toBeNull();
    expect(result.variants).toHaveLength(2);
    expect(result.variants?.[0]).toMatchObject({ dose_amount: 200, frequency_per_day: 2 });
    expect(result.variants?.[1]).toMatchObject({
      dose_amount: 400,
      frequency_per_day: 1,
      duration_days: 10,
      route: 'внутрь',
    });
  });
  it('разбирает комбинацию со slash в двух вариантах', () => {
    const result = parseRegimen(
      'Амоксициллин+Клавулановая кислота внутрь 500/125 мг 3 раза в сутки или 875/125 мг 2 раза в сутки',
    );
    expect(result.variants?.[0].components).toEqual([
      { amount: 500, unit: 'мг' },
      { amount: 125, unit: 'мг' },
    ]);
    expect(result.variants?.[1].components).toEqual([
      { amount: 875, unit: 'мг' },
      { amount: 125, unit: 'мг' },
    ]);
    expect(result.parse_status).toBe('REVIEW_REQUIRED');
  });
  it('отделяет загрузочный день доксициклина от поддерживающей суточной дозы', () => {
    const text =
      'Доксициклин 200 мг в первый день (делится на 2 приема - по 100 мг 2 раза в сутки), далее по 100 мг/сут курсом 7 дней';
    expect(parseRegimen(text)).toMatchObject({
      dose_amount: 100,
      dose_unit: 'мг/сут',
      frequency_per_day: null,
      duration_days: 7,
      loading_dose: {
        dose_amount: 200,
        dose_unit: 'мг',
        duration_days: 1,
        frequency_per_day: 2,
        dose_per_administration: 100,
      },
      source_text: text,
      parse_status: 'REVIEW_REQUIRED',
    });
  });
  it.each([
    ['Азитромицин 500 мг по 1 таблетке 1 раз курсом 5 дней', 'frequency_per_day'],
    ['Амоксициллин 500- 1000мг по 2 таблетки 3 раза в сутки курсом 10 дней', 'dose_amount'],
    ['Не предусмотрено', 'dose_amount'],
  ])('не придумывает недостающие данные: %s', (text, missing) => {
    const result = parseRegimen(text);
    expect(result).toHaveProperty(missing, null);
    expect(result.parse_status).toBe('REVIEW_REQUIRED');
    expect(result.source_text).toBe(text);
  });
  it('разбирает числовые диапазоны дозы и длительности', () => {
    expect(
      parseRegimen('Клиндамицин внутримышечно, 400-900 мг 3 раза в сутки, в течение 7-10 дней'),
    ).toMatchObject({
      dose_amount: 400,
      dose_max: 900,
      dose_unit: 'мг',
      route: 'внутримышечно',
      frequency_per_day: 3,
      duration_days: 7,
      duration_max_days: 10,
      parse_status: 'STRUCTURED',
    });
  });
  it('вычисляет разовую дозу из явно указанной суточной дозы и числа приёмов', () => {
    expect(parseRegimen('Цефалексин внутрь 1000 мг в сутки в 2 приема курсом 10 дней')).toMatchObject({
      dose_amount: 500,
      dose_unit: 'мг',
      frequency_per_day: 2,
      duration_days: 10,
    });
  });
  it('сохраняет единицы миллионов МЕ и не подменяет их миллиграммами', () => {
    expect(parseRegimen('Спирамицин внутрь 3 млн МЕ 2 раза в сутки курсом 10 дней')).toMatchObject({
      dose_amount: 3,
      dose_unit: 'млн МЕ',
      parse_status: 'STRUCTURED',
    });
  });
  it('не превращает дозу на килограмм в абсолютную разовую дозу', () => {
    const result = parseRegimen('Препарат внутрь 10 мг/кг 2 раза в сутки курсом 7 дней');
    expect(result.dose_amount).toBeNull();
    expect(result.parse_status).toBe('REVIEW_REQUIRED');
  });
  it('не теряет третий компонент и не объявляет неполную комбинацию структурированной', () => {
    const result = parseRegimen('Препарат внутрь 100 мг + 20 мг + 5 мг 2 раза в сутки курсом 7 дней');
    expect(result.components).toEqual([
      { amount: 100, unit: 'мг' },
      { amount: 20, unit: 'мг' },
      { amount: 5, unit: 'мг' },
    ]);
  });
  it('не использует первую из противоречащих друг другу частот приёма', () => {
    const result = parseRegimen('Препарат внутрь 500 мг 2 раза в сутки, 3 раза в сутки курсом 7 дней');
    expect(result.frequency_per_day).toBeNull();
    expect(result.parse_status).toBe('REVIEW_REQUIRED');
  });
});

describe('resolveTherapy: безопасность', () => {
  it.each([
    [['ALLOW', 'WARN'], 'WARN', 'ELIGIBLE'],
    [['WARN', 'REVIEW_REQUIRED'], 'REVIEW_REQUIRED', 'REVIEW_REQUIRED'],
    [['BLOCK', 'REVIEW_REQUIRED', 'WARN', 'ALLOW'], 'BLOCK', 'BLOCKED'],
  ] as const)('применяет предшествование действий %j', (actions, action, eligibility) => {
    const result = resolveTherapy(
      content({ contraindications: actions.map((a) => safety(a)) }),
      'S',
      draft(),
    );
    expect(result.options).toHaveLength(1);
    expect(result.options[0]).toMatchObject({ action, eligibility });
    expect(result.options[0].findings).toHaveLength(actions.length);
  });
  it('оставляет заблокированный вариант и причины исключения в результате и trace', () => {
    const result = resolveTherapy(content({ contraindications: [safety('BLOCK')] }), 'S', draft());
    expect(result.options[0].findings[0]).toMatchObject({ action: 'BLOCK', rule_id: 'rule-BLOCK' });
    expect(JSON.stringify(result.trace)).toContain('rule-BLOCK');
  });
  it('не активирует выключенный либо невалидированный mock даже при истинном условии', () => {
    const result = resolveTherapy(
      content({
        contraindications: [
          safety('BLOCK', { enabled: false }),
          safety('BLOCK', { rule_id: 'unvalidated', validation_status: 'MOCK_EXAMPLE' }),
        ],
      }),
      'S',
      draft(),
    );
    expect(result.options[0]).toMatchObject({ action: 'ALLOW', eligibility: 'ELIGIBLE', findings: [] });
    expect(result.safety_status).toBe('INCOMPLETE');
    expect(result.warnings.length).toBeGreaterThan(0);
  });
  it('не превращает неизвестное safety-условие в отрицательный результат', () => {
    const result = resolveTherapy(
      content({
        contraindications: [
          safety('BLOCK', { condition: { kind: 'REF', ref_type: 'FACT', ref_id: 'risk' } }),
        ],
      }),
      'S',
      draft({ facts: { risk: fact(null, 'UNKNOWN') } }),
    );
    expect(result.options[0]).toMatchObject({ action: 'REVIEW_REQUIRED', eligibility: 'REVIEW_REQUIRED' });
    expect(result.safety_status).toBe('INCOMPLETE');
    expect(JSON.stringify(result.trace)).toContain('risk');
  });
  it('не ограничивает препарат по ложному условию и правилу другой нозологии', () => {
    const result = resolveTherapy(
      content({
        contraindications: [
          safety('BLOCK', { condition: { kind: 'LITERAL', value: false } }),
          safety('BLOCK', { nosology_code: 'OTHER' }),
        ],
      }),
      'S',
      draft(),
    );
    expect(result.options[0]).toMatchObject({ action: 'ALLOW', findings: [] });
  });
  it('проверяет DDI только для реально указанных сопутствующих препаратов', () => {
    const input = content({ interactions: [safety('BLOCK', { concomitant_drug_id: 2 })] });
    expect(resolveTherapy(input, 'S', draft()).options[0].action).toBe('ALLOW');
    const result = resolveTherapy(
      input,
      'S',
      draft({ medications: { state: 'KNOWN_LIST', drug_ids: [2], unrecognized: [] } }),
    );
    expect(result.options[0].action).toBe('BLOCK');
  });
  it.each([
    { state: 'UNKNOWN', drug_ids: [], unrecognized: [] },
    { state: 'KNOWN_LIST', drug_ids: [], unrecognized: ['не распознано'] },
  ] as CaseDraft['medications'][])('помечает неполную DDI-проверку при %j', (medications) => {
    const result = resolveTherapy(
      content({
        contraindications: [safety('ALLOW')],
        interactions: [safety('ALLOW', { concomitant_drug_id: 2 })],
      }),
      'S',
      draft({ medications }),
    );
    expect(result.safety_status).toBe('INCOMPLETE');
    expect(result.warnings.length).toBeGreaterThan(0);
  });
  it('отличает проверенный набор без findings от отсутствующего справочника', () => {
    const input = content({
      contraindications: [safety('BLOCK', { condition: { kind: 'LITERAL', value: false } })],
      interactions: [safety('BLOCK', { concomitant_drug_id: 2 })],
    });
    const result = resolveTherapy(input, 'S', draft());
    expect(result.safety_status).toBe('COMPLETE');
    expect(result.options[0].findings).toEqual([]);
    expect(resolveTherapy(content(), 'S', draft()).safety_status).toBe('INCOMPLETE');
  });
  it('не использует выключенные DDI даже для указанной пары препаратов', () => {
    const result = resolveTherapy(
      content({ interactions: [safety('BLOCK', { enabled: false, concomitant_drug_id: 2 })] }),
      'S',
      draft({ medications: { state: 'KNOWN_LIST', drug_ids: [2], unrecognized: [] } }),
    );
    expect(result.options[0]).toMatchObject({ action: 'ALLOW', findings: [] });
  });
  it('исполняет правило пары препаратов без дополнительного AST-условия', () => {
    const result = resolveTherapy(
      content({ interactions: [safety('BLOCK', { condition: undefined, concomitant_drug_id: 2 })] }),
      'S',
      draft({ medications: { state: 'KNOWN_LIST', drug_ids: [2], unrecognized: [] } }),
    );
    expect(result.options[0].action).toBe('BLOCK');
  });
  it('не исполняет противопоказание без условия как безусловный запрет', () => {
    const result = resolveTherapy(
      content({ contraindications: [safety('BLOCK', { condition: undefined })] }),
      'S',
      draft(),
    );
    expect(result.options[0].action).toBe('REVIEW_REQUIRED');
    expect(result.safety_status).toBe('INCOMPLETE');
  });
});

describe('resolveTherapy: дозирование', () => {
  it.each([
    { rules: [] },
    { rules: [dose({ enabled: false })] },
    { rules: [dose({ validation_status: 'MOCK_EXAMPLE' })] },
    { rules: [dose({ nosology_code: 'OTHER' })] },
    { rules: [dose({ drug_id: 2 })] },
  ])('сохраняет базовый режим без активного правила для нозологии и препарата', ({ rules }) => {
    const result = resolveTherapy(content({ dose_rules: rules }), 'S', draft());
    expect(result.options[0].regimen).toMatchObject({ dose_amount: 500, source_text: baseText });
    expect(result.options[0].dose_status).toBe('BASE_REGIMEN');
    expect(JSON.stringify(result.trace)).toContain('USE_BASE_REGIMEN');
  });
  it('сохраняет базовый режим и missing facts при недостаточных данных', () => {
    const result = resolveTherapy(
      content({ dose_rules: [dose({ required_facts: ['renal'] })] }),
      'S',
      draft(),
    );
    expect(result.options[0].regimen.dose_amount).toBe(500);
    expect(result.options[0].dose_status).toBe('BASE_REGIMEN_MISSING_DATA');
    expect(JSON.stringify(result.trace)).toContain('renal');
  });
  it('не считает KNOWN/null доступным фактом корректировки', () => {
    const result = resolveTherapy(
      content({ dose_rules: [dose({ required_facts: ['renal'] })] }),
      'S',
      draft({ facts: { renal: fact(null) } }),
    );
    expect(result.options[0].regimen.dose_amount).toBe(500);
    expect(result.options[0].dose_status).toBe('BASE_REGIMEN_MISSING_DATA');
  });
  it('применяет единственное подходящее валидированное правило без изменения content', () => {
    const input = content({ dose_rules: [dose({ required_facts: ['renal'] })] });
    const before = JSON.stringify(input);
    const result = resolveTherapy(input, 'S', draft({ facts: { renal: fact(10) } }));
    expect(result.options[0]).toMatchObject({ dose_status: 'ADJUSTED', regimen: { dose_amount: 250 } });
    expect(JSON.stringify(result.trace)).toContain('dose-test');
    result.options[0].regimen.dose_amount = 999;
    expect(JSON.stringify(input)).toBe(before);
  });
  it('не выбирает произвольно одно из конфликтующих правил корректировки', () => {
    const result = resolveTherapy(
      content({
        dose_rules: [dose(), dose({ rule_id: 'dose-second', regimen: { ...baseRegimen, dose_amount: 125 } })],
      }),
      'S',
      draft(),
    );
    expect(result.options[0]).toMatchObject({
      dose_status: 'BASE_REGIMEN_CONFLICT',
      action: 'REVIEW_REQUIRED',
      regimen: { dose_amount: 500 },
    });
  });
  it('не возвращает схему другой нозологии и явно фиксирует это в trace', () => {
    const result = resolveTherapy(content(), 'S', draft({ nosology_code: 'OTHER' }));
    expect(result.options).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.trace.length).toBeGreaterThan(0);
  });
  it('сохраняет базовый режим при неизвестном условии корректировки', () => {
    const result = resolveTherapy(
      content({
        dose_rules: [dose({ condition: { kind: 'REF', ref_type: 'FACT', ref_id: 'unknown_adjustment' } })],
      }),
      'S',
      draft(),
    );
    expect(result.options[0]).toMatchObject({
      dose_status: 'BASE_REGIMEN_MISSING_DATA',
      regimen: { dose_amount: 500 },
    });
  });
  it('сохраняет базовый режим при ложном условии корректировки', () => {
    const result = resolveTherapy(
      content({ dose_rules: [dose({ condition: { kind: 'LITERAL', value: false } })] }),
      'S',
      draft(),
    );
    expect(result.options[0]).toMatchObject({ dose_status: 'BASE_REGIMEN', regimen: { dose_amount: 500 } });
  });
});
