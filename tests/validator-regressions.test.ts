import { describe, expect, it } from 'vitest';
import type { Expression, RulePackage } from '../packages/contracts/src/index.ts';
import { validatePackage } from '../packages/clinical/src/validator.ts';
import { hashRules } from '../packages/clinical/src/hash.ts';

const compare = (operator: string, value: number): Expression => ({
  kind: 'OP',
  operator,
  operands: [
    { kind: 'REF', ref_type: 'FACT', ref_id: 'TEST_VALUE' },
    { kind: 'LITERAL', value },
  ],
});

/** Изолированный технический граф, без медицинских рекомендаций. */
function fixture(first = compare('LTE', 0), second = compare('GT', 0)): RulePackage {
  return {
    contract_version: '0.1.0',
    package_type: 'CLINICAL_RULESET',
    ruleset_version: '0.1.0',
    status: 'DRAFT',
    component_versions: {
      clinical_rules: '0.1.0',
      drug_registry: '0.1.0',
      contraindications: '0.1.0',
      interactions: '0.1.0',
      dose_rules: '0.1.0',
    },
    nosologies: [
      { nosology_code: 'TEST_A', name_ru: 'Синтетическая нозология А', root_node_id: 'A-ROOT', active: true },
      { nosology_code: 'TEST_B', name_ru: 'Синтетическая нозология Б', root_node_id: 'B-END', active: true },
    ],
    fact_definitions: [
      {
        fact_code: 'TEST_VALUE',
        label_ru: 'Синтетическая величина',
        data_type: 'DECIMAL',
        unknown_allowed: true,
        unknown_policy: 'BLOCK_EVALUATION_IF_REQUIRED',
      },
    ],
    score_groups: [],
    nodes: [
      {
        node_id: 'A-ROOT',
        nosology_code: 'TEST_A',
        node_type: 'RANGE_DECISION',
        input_ref: 'TEST_VALUE',
        unknown_behavior: 'BLOCK_EVALUATION_IF_REQUIRED',
        resolution_status: 'TECHNICAL_DEFAULT',
      },
      {
        node_id: 'A-LOW',
        nosology_code: 'TEST_A',
        node_type: 'TERMINAL_SCHEME',
        output_ref: 'SCHEME_A',
        resolution_status: 'TECHNICAL_DEFAULT',
      },
      {
        node_id: 'A-HIGH',
        nosology_code: 'TEST_A',
        node_type: 'TERMINAL_SCHEME',
        output_ref: 'SCHEME_A',
        resolution_status: 'TECHNICAL_DEFAULT',
      },
      {
        node_id: 'B-END',
        nosology_code: 'TEST_B',
        node_type: 'TERMINAL_SCHEME',
        output_ref: 'SCHEME_B',
        resolution_status: 'TECHNICAL_DEFAULT',
      },
    ],
    edges: [
      {
        edge_id: 'A-E1',
        nosology_code: 'TEST_A',
        from_node_id: 'A-ROOT',
        to_node_id: 'A-LOW',
        branch_code: 'LOW',
        condition: first,
        priority: 1,
        resolution_status: 'TECHNICAL_DEFAULT',
      },
      {
        edge_id: 'A-E2',
        nosology_code: 'TEST_A',
        from_node_id: 'A-ROOT',
        to_node_id: 'A-HIGH',
        branch_code: 'HIGH',
        condition: second,
        priority: 2,
        resolution_status: 'TECHNICAL_DEFAULT',
      },
    ],
    schemes: [
      {
        scheme_id: 'SCHEME_A',
        nosology_code: 'TEST_A',
        scheme_root: 'SCHEME_A',
        resolution_status: 'TECHNICAL_DEFAULT',
      },
      {
        scheme_id: 'SCHEME_B',
        nosology_code: 'TEST_B',
        scheme_root: 'SCHEME_B',
        resolution_status: 'TECHNICAL_DEFAULT',
      },
    ],
    terminal_states: [],
    treatment_options: [
      {
        treatment_option_id: 'OPTION_A',
        scheme_id: 'SCHEME_A',
        line_type: 'FIRST_LINE',
        option_group: 1,
        drug_id: 1,
        base_regimen_text: 'Амоксициллин: синтетическая строка проверки структуры',
      },
      {
        treatment_option_id: 'OPTION_B',
        scheme_id: 'SCHEME_B',
        line_type: 'FIRST_LINE',
        option_group: 1,
        drug_id: 1,
        base_regimen_text: 'Амоксициллин: синтетическая строка проверки структуры',
      },
    ],
    provenance: {
      source_basis: [{ source_type: 'OTHER', document_id: 'validator-regression-test' }],
      normalization_policy: 'Синтетический fixture; не медицинский контент',
    },
  };
}

describe('семантическая валидация: узкие десятичные интервалы', () => {
  it.each([0.0001, 0.00000001])('обнаруживает пробел шириной %s между границами', (width) => {
    const report = validatePackage(fixture(compare('LTE', 0), compare('GTE', width)));
    expect(report.valid).toBe(false);
    expect(report.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'COVERAGE_GAP' })]),
    );
  });
  it.each([0.0001, 0.00000001])('обнаруживает пересечение шириной %s между границами', (width) => {
    const report = validatePackage(fixture(compare('LT', width), compare('GT', 0)));
    expect(report.valid).toBe(false);
    expect(report.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'AMBIGUOUS_BRANCH' })]),
    );
  });
  it('принимает полное разделение по одной десятичной границе', () => {
    expect(validatePackage(fixture(compare('LTE', 0.0001), compare('GT', 0.0001))).errors).toEqual([]);
  });
  it('не считает пересечение за пределами объявленного диапазона допустимым входом', () => {
    const p = fixture(compare('LT', 0.0001), compare('GT', 0));
    p.fact_definitions[0].min_value = 1;
    expect(validatePackage(p).errors).toEqual([]);
  });
  it('не создаёт дробные входы для INTEGER между соседними целыми', () => {
    const p = fixture(compare('LTE', 0), compare('GTE', 1));
    p.fact_definitions[0].data_type = 'INTEGER';
    expect(validatePackage(p).errors).toEqual([]);
  });
});

describe('семантическая валидация: область схемы', () => {
  it('отвергает терминал, который ссылается на существующую схему другой нозологии', () => {
    const p = fixture();
    p.nodes.find((n) => n.node_id === 'A-LOW')!.output_ref = 'SCHEME_B';
    const report = validatePackage(p);
    expect(report.valid).toBe(false);
    expect(report.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'CROSS_NOSOLOGY' })]),
    );
  });
  it('отвергает перенос используемой схемы в другую нозологию', () => {
    const p = fixture();
    p.schemes[0].nosology_code = 'TEST_B';
    expect(validatePackage(p).errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'CROSS_NOSOLOGY' })]),
    );
  });
  it('отвергает схему с неизвестным кодом нозологии', () => {
    const p = fixture();
    p.schemes.push({
      scheme_id: 'ORPHAN',
      nosology_code: 'MISSING',
      scheme_root: 'ORPHAN',
      resolution_status: 'TECHNICAL_DEFAULT',
      terminal_state_override: 'ABT_NOT_INDICATED',
    });
    expect(validatePackage(p).errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'UNKNOWN_NOSOLOGY' })]),
    );
  });
  it('принимает ссылки внутри нозологии', () => {
    expect(validatePackage(fixture()).errors).toEqual([]);
  });
});

describe('семантическая валидация: версии компонентов', () => {
  it.each(['0.1.1', '0.1.12'])('принимает согласованную опубликованную версию %s', (version) => {
    const p = fixture();
    p.ruleset_version = version;
    p.component_versions.clinical_rules = version;
    p.status = 'PUBLISHED';
    p.ruleset_hash = hashRules(p);
    expect(validatePackage(p).errors).toEqual([]);
  });
  it('отвергает отставшую версию clinical_rules от ruleset_version', () => {
    const p = fixture();
    p.ruleset_version = '0.1.1';
    const report = validatePackage(p);
    expect(report.valid).toBe(false);
    expect(report.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'INCOMPATIBLE_VERSION' })]),
    );
  });
  it.each(['drug_registry', 'contraindications', 'interactions', 'dose_rules'])(
    'оставляет внешний компонент %s привязанным к поддерживаемой версии',
    (component) => {
      const p = fixture();
      p.component_versions[component] = '0.1.1';
      expect(validatePackage(p).errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'INCOMPATIBLE_VERSION' })]),
      );
    },
  );
  it('не расширяет поддерживаемую линию контракта до 0.2.x', () => {
    const p = fixture();
    p.ruleset_version = '0.2.0';
    p.component_versions.clinical_rules = '0.2.0';
    expect(validatePackage(p).valid).toBe(false);
  });
});

describe('семантическая валидация: принадлежность режима препарату', () => {
  it('отвергает режим распознанного МНН с идентификатором другого препарата', () => {
    const p = fixture();
    p.treatment_options[0].base_regimen_text = 'Кларитромицин 500 мг 2 раза в день курсом 10 дней';
    p.treatment_options[0].drug_id = 3;
    const report = validatePackage(p);
    expect(report.valid).toBe(false);
    expect(report.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'DRUG_REGIMEN_MISMATCH' })]),
    );
  });
  it('принимает распознанное МНН с соответствующим идентификатором', () => {
    const p = fixture();
    p.treatment_options[0].base_regimen_text = 'Кларитромицин 500 мг 2 раза в день курсом 10 дней';
    p.treatment_options[0].drug_id = 4;
    expect(validatePackage(p).errors).toEqual([]);
  });
  it('не назначает произвольный идентификатор нераспознанному названию', () => {
    const p = fixture();
    p.treatment_options[0].base_regimen_text = 'Неизвестное наименование: требуется отдельная проверка';
    const report = validatePackage(p);
    expect(report.errors.some((e) => e.code === 'DRUG_REGIMEN_MISMATCH')).toBe(false);
    expect(report.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'DRUG_REGIMEN_REVIEW_REQUIRED' })]),
    );
  });
});
