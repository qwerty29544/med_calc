import { z } from 'zod';
import type {
  ClinicalContent,
  DoseRule,
  Expression,
  Regimen,
  RulePackage,
  SafetyRule,
  ValidationReport,
} from '../../../packages/contracts/src';
import type { AuxiliaryPackage, MedicalPackage } from '../../../packages/db/src/store';
import { hashContent, hashRules } from '../../../packages/clinical/src/hash';
import { compileAuthoring, validatePackage } from '../../../packages/clinical/src/service';
export const isClinical = (p: MedicalPackage): p is RulePackage => p.package_type === 'CLINICAL_RULESET';
export const packageHash = (p: MedicalPackage) => (isClinical(p) ? hashRules(p) : hashContent(p));
export const packageVersion = (p: MedicalPackage) => (isClinical(p) ? p.ruleset_version : p.version);
const lifecycle = z.enum(['DRAFT', 'IN_REVIEW', 'VALIDATED', 'PUBLISHED', 'RETIRED']);
const version = z.string().regex(/^0\.1\.\d+$/);
const expr: z.ZodType<Expression> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('REF'),
      ref_type: z.enum(['FACT', 'SCORE', 'DERIVED_FACT']),
      ref_id: z.string().min(1),
    }),
    z.strictObject({
      kind: z.literal('LITERAL'),
      value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
      unit: z.string().nullable().optional(),
    }),
    z.strictObject({
      kind: z.literal('OP'),
      operator: z.enum([
        'AND',
        'OR',
        'NOT',
        'EQ',
        'NEQ',
        'GT',
        'GTE',
        'LT',
        'LTE',
        'BETWEEN',
        'IN',
        'NOT_IN',
        'IS_KNOWN',
        'IS_UNKNOWN',
      ]),
      operands: z.array(expr).min(1).max(100),
    }),
  ]),
);
const regimen: z.ZodType<Regimen> = z.lazy(() =>
  z.strictObject({
    dose_amount: z.number().positive().nullable(),
    dose_max: z.number().positive().nullable().optional(),
    dose_unit: z.string().nullable(),
    route: z.string().nullable(),
    frequency_per_day: z.number().positive().nullable(),
    duration_days: z.number().positive().nullable(),
    duration_max_days: z.number().positive().nullable().optional(),
    loading_dose: z
      .strictObject({
        dose_amount: z.number().positive(),
        dose_unit: z.string(),
        duration_days: z.number().positive(),
        frequency_per_day: z.number().positive().optional(),
        dose_per_administration: z.number().positive().optional(),
      })
      .nullable()
      .optional(),
    source_text: z.string().min(1),
    parse_status: z.enum(['STRUCTURED', 'REVIEW_REQUIRED']),
    variants: z.array(regimen).optional(),
    components: z.array(z.strictObject({ amount: z.number().positive(), unit: z.string() })).optional(),
  }),
);
const commonRule = {
  rule_id: z.string().min(1).max(100),
  drug_id: z.number().int().positive(),
  nosology_code: z.string().min(1).optional(),
  source: z.string().min(1),
  enabled: z.boolean(),
  validation_status: z.string().min(1),
};
const safety = z.strictObject({
  ...commonRule,
  condition: expr.optional(),
  concomitant_drug_id: z.number().int().positive().optional(),
  action: z.enum(['ALLOW', 'WARN', 'BLOCK', 'REVIEW_REQUIRED']),
  message: z.string().min(1).max(2000),
});
const dose = z.strictObject({
  ...commonRule,
  nosology_code: z.string().min(1),
  condition: expr,
  required_facts: z.array(z.string()),
  regimen,
});
const meta = {
  version,
  status: lifecycle,
  created_at: z.string().datetime().optional(),
  published_at: z.string().datetime().nullable().optional(),
  provenance: z.strictObject({ source: z.string().min(1), note: z.string().optional() }),
  compatibility: z.strictObject({ clinical_ruleset: version }),
};
const aux = z.discriminatedUnion('package_type', [
  z.strictObject({
    ...meta,
    package_type: z.literal('drug_registry'),
    drugs: z
      .array(
        z.strictObject({
          drug_id: z.number().int().positive(),
          generic_name_ru: z.string().min(1),
          normalized_code: z.string().min(1),
          aliases: z.array(z.string()),
          active: z.boolean().optional(),
        }),
      )
      .min(1),
  }),
  z.strictObject({ ...meta, package_type: z.literal('contraindication_ruleset'), rules: z.array(safety) }),
  z.strictObject({ ...meta, package_type: z.literal('interaction_ruleset'), rules: z.array(safety) }),
  z.strictObject({ ...meta, package_type: z.literal('dose_ruleset'), rules: z.array(dose) }),
]);
export function normalizePackage(payload: unknown): MedicalPackage {
  if (
    payload &&
    typeof payload === 'object' &&
    'package_type' in payload &&
    ['drug_registry', 'contraindication_ruleset', 'interaction_ruleset', 'dose_ruleset'].includes(
      String(payload.package_type),
    )
  )
    return aux.parse(payload) as AuxiliaryPackage;
  return payload && typeof payload === 'object' && 'contract_version' in payload
    ? (structuredClone(payload) as RulePackage)
    : compileAuthoring(payload);
}
export function validateMedicalPackage(payload: MedicalPackage, content: ClinicalContent): ValidationReport {
  if (isClinical(payload)) return validatePackage(payload);
  const report: ValidationReport = { valid: false, errors: [], warnings: [] };
  const parsed = aux.safeParse(payload);
  if (!parsed.success) {
    report.errors = parsed.error.issues.map((e) => ({
      code: 'SCHEMA_ERROR',
      message: e.message,
      path: e.path.join('.'),
    }));
    return report;
  }
  const error = (code: string, message: string) => report.errors.push({ code, message });
  if (payload.compatibility.clinical_ruleset !== content.rules.ruleset_version)
    error('INCOMPATIBLE_VERSION', 'Пакет требует другую версию клинического графа');
  if (payload.package_type === 'drug_registry') {
    const drugs = payload.drugs ?? [];
    if (
      new Set(drugs.map((d) => d.drug_id)).size !== drugs.length ||
      new Set(drugs.map((d) => d.normalized_code)).size !== drugs.length
    )
      error('DUPLICATE_ID', 'Идентификаторы препаратов должны быть уникальны');
    for (const drug of drugs) {
      const previous = content.drugs.find((d) => d.drug_id === drug.drug_id);
      if (previous && previous.normalized_code !== drug.normalized_code)
        error('DRUG_ID_REASSIGNMENT', `Нельзя переопределить drug_id ${drug.drug_id} другим МНН`);
    }
    if (content.rules.treatment_options.some((t) => !drugs.some((d) => d.drug_id === t.drug_id)))
      error('MISSING_DRUG', 'Не все препараты клинического графа присутствуют в справочнике');
  } else {
    const rules = payload.rules ?? [];
    if (new Set(rules.map((r) => r.rule_id)).size !== rules.length) error('DUPLICATE_ID', 'Повтор rule_id');
    for (const r of rules) {
      if (!content.drugs.some((d) => d.drug_id === r.drug_id)) error('UNKNOWN_DRUG', r.rule_id);
      if (r.enabled && r.validation_status !== 'VALIDATED')
        error('UNVALIDATED_RULE', `${r.rule_id}: включать можно только VALIDATED`);
      if (
        r.nosology_code &&
        r.nosology_code !== 'ALL' &&
        !content.rules.nosologies.some((n) => n.nosology_code === r.nosology_code)
      )
        error('UNKNOWN_NOSOLOGY', r.rule_id);
      if (
        payload.package_type === 'interaction_ruleset' &&
        (!('concomitant_drug_id' in r) || !content.drugs.some((d) => d.drug_id === r.concomitant_drug_id))
      )
        error('UNKNOWN_CONCOMITANT_DRUG', r.rule_id);
      if (payload.package_type === 'contraindication_ruleset' && !r.condition)
        error('MISSING_CONDITION', r.rule_id);
      if (r.condition && checkExpression(r.condition, content, 0, error, r.rule_id) !== 'boolean')
        error('CONDITION_TYPE', `${r.rule_id}: условие должно иметь тип BOOLEAN`);
      if ('regimen' in r) {
        checkRegimen(r.regimen, error, r.rule_id);
        if (r.required_facts.some((f) => !content.rules.fact_definitions.some((d) => d.fact_code === f)))
          error('UNKNOWN_FACT', r.rule_id);
      }
    }
  }
  if (payload.status !== 'PUBLISHED')
    report.warnings.push({ code: 'UNPUBLISHED_CONTENT', message: 'Пакет еще не опубликован' });
  report.valid = !report.errors.length;
  return report;
}
function checkExpression(
  e: Expression,
  content: ClinicalContent,
  depth: number,
  error: (c: string, m: string) => void,
  id: string,
): string {
  if (depth > 32) {
    error('AST_DEPTH', id);
    return 'invalid';
  }
  if (e.kind === 'LITERAL') return e.value === null ? 'null' : typeof e.value;
  if (e.kind === 'REF') {
    const f = content.rules.fact_definitions.find((x) => x.fact_code === e.ref_id);
    if (e.ref_type !== 'FACT' || !f) {
      error('UNKNOWN_FACT', `${id}: ${e.ref_id}; неподдерживаемая ссылка`);
      return 'invalid';
    }
    return ['INTEGER', 'DECIMAL'].includes(f.data_type)
      ? 'number'
      : f.data_type === 'BOOLEAN'
        ? 'boolean'
        : 'string';
  }
  const n = e.operands.length;
  if (
    (['NOT', 'IS_KNOWN', 'IS_UNKNOWN'].includes(e.operator) && n !== 1) ||
    (['EQ', 'NEQ', 'GT', 'GTE', 'LT', 'LTE'].includes(e.operator) && n !== 2) ||
    (e.operator === 'BETWEEN' && n !== 3) ||
    (['AND', 'OR', 'IN', 'NOT_IN'].includes(e.operator) && n < 2)
  )
    error('AST_ARITY', id);
  const types = e.operands.map((child) => checkExpression(child, content, depth + 1, error, id));
  if (['AND', 'OR', 'NOT'].includes(e.operator) && types.some((t) => t !== 'boolean'))
    error('AST_TYPE', `${id}: логическая операция требует BOOLEAN`);
  if (['GT', 'GTE', 'LT', 'LTE', 'BETWEEN'].includes(e.operator) && types.some((t) => t !== 'number'))
    error('AST_TYPE', `${id}: числовое сравнение требует NUMBER`);
  if (
    ['EQ', 'NEQ', 'IN', 'NOT_IN'].includes(e.operator) &&
    (types.includes('null') || types.some((t) => t !== types[0]))
  )
    error('AST_TYPE', `${id}: несовместимые типы`);
  const units = e.operands
    .map((o) =>
      o.kind === 'REF'
        ? content.rules.fact_definitions.find((f) => f.fact_code === o.ref_id)?.unit
        : o.kind === 'LITERAL'
          ? o.unit
          : undefined,
    )
    .filter((u): u is string => u != null);
  if (units.some((u) => u !== units[0])) error('UNIT_MISMATCH', `${id}: единицы несовместимы`);
  return 'boolean';
}
function checkRegimen(r: Regimen, error: (c: string, m: string) => void, id: string) {
  if (r.parse_status !== 'STRUCTURED') error('UNSTRUCTURED_DOSE', id);
  if (r.variants?.length) {
    for (const variant of r.variants) checkRegimen(variant, error, id);
    return;
  }
  if (
    (r.dose_amount === null && !r.components?.length) ||
    !r.dose_unit?.trim() ||
    !r.route?.trim() ||
    r.frequency_per_day === null ||
    r.duration_days === null
  )
    error('INCOMPLETE_REGIMEN', id);
  if (
    (r.dose_max != null && r.dose_amount != null && r.dose_max < r.dose_amount) ||
    (r.duration_max_days != null && r.duration_days != null && r.duration_max_days < r.duration_days)
  )
    error('INVALID_REGIMEN_RANGE', id);
}
export function overlay(content: ClinicalContent, p: MedicalPackage): ClinicalContent {
  if (isClinical(p))
    return {
      ...content,
      rules: structuredClone(p),
      hashes: { ...content.hashes, clinical_rules: packageHash(p) },
    };
  const names = {
    drug_registry: 'drug_registry',
    contraindication_ruleset: 'contraindications',
    interaction_ruleset: 'interactions',
    dose_ruleset: 'dose_rules',
  } as const;
  const key = names[p.package_type];
  const next = {
    ...content,
    versions: { ...content.versions, [key]: p.version },
    hashes: { ...content.hashes, [key]: packageHash(p) },
  };
  if (p.package_type === 'drug_registry') return { ...next, drugs: structuredClone(p.drugs ?? []) };
  if (p.package_type === 'contraindication_ruleset')
    return { ...next, contraindications: structuredClone(p.rules ?? []) as SafetyRule[] };
  if (p.package_type === 'interaction_ruleset')
    return { ...next, interactions: structuredClone(p.rules ?? []) as SafetyRule[] };
  return { ...next, dose_rules: structuredClone(p.rules ?? []) as DoseRule[] };
}
