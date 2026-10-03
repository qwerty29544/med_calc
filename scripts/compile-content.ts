import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { compileAuthoring } from '../packages/clinical/src/compiler';
import { validatePackage } from '../packages/clinical/src/validator';
import { hashContent } from '../packages/clinical/src/hash';
import type { Action, Drug, SafetyRule } from '../packages/contracts/src';
const read = (file: string) => JSON.parse(readFileSync(resolve('content/source', file + '.json'), 'utf8'));
const out = resolve('content/canonical');
mkdirSync(out, { recursive: true });
const write = (name: string, data: unknown) =>
  writeFileSync(resolve(out, name + '.json'), JSON.stringify(data, null, 2) + '\n');
const rows = (data: (string | number | boolean | null)[][]): Record<string, unknown>[] =>
  data
    .slice(1)
    .filter((r) => r[0] != null)
    .map((r) => Object.fromEntries(data[0]!.map((h, i) => [String(h), r[i] ?? null])));
const clinical = compileAuthoring(read('clinical-rules'));
const report = validatePackage(clinical);
if (!report.valid) {
  console.error(report);
  process.exitCode = 1;
  throw new Error('Пакет не прошел валидацию');
}
write('clinical-rules', clinical);
write('validation-report', report);
const drugs: Drug[] = rows(read('01_drug_registry_v0.1.0').Drugs).map((r) => ({
  drug_id: Number(r.drug_id),
  generic_name_ru: String(r.generic_name_ru),
  normalized_code: String(r.normalized_code),
  active: r.active === true,
  aliases: [String(r.normalized_code).replaceAll('_', ' ')],
}));
write('drug-registry', { package_type: 'drug_registry', version: '0.1.0', status: 'DRAFT', drugs });
const actions: Record<string, Action> = {
  EXCLUDE: 'BLOCK',
  KEEP_WITH_WARNING: 'WARN',
  WARNING: 'WARN',
  ALLOW: 'ALLOW',
  KEEP: 'ALLOW',
  REVIEW_REQUIRED: 'REVIEW_REQUIRED',
  REQUIRE_REVIEW: 'REVIEW_REQUIRED',
};
const ci = rows(read('02_contraindications_mock_v0.1.0').ContraindicationRules).map((r) => ({
  rule_id: String(r.rule_id),
  drug_id: Number(r.drug_id),
  nosology_code: String(r.nosology_code),
  condition: {
    kind: 'OP',
    operator: String(r.operator),
    operands: [
      { kind: 'REF', ref_type: 'FACT', ref_id: String(r.criterion_code) },
      { kind: 'LITERAL', value: r.threshold_value },
    ],
  },
  action: actions[String(r.action)] ?? 'REVIEW_REQUIRED',
  message: String(r.message_template_ru),
  source: String(r.source_reference),
  enabled: false,
  validation_status: String(r.validation_status),
})) as SafetyRule[];
const ddi = rows(read('03_drug_interactions_mock_v0.1.0').InteractionRules).map((r) => ({
  rule_id: String(r.interaction_rule_id),
  drug_id: Number(r.primary_drug_id),
  nosology_code: String(r.nosology_code),
  action: actions[String(r.action)] ?? 'REVIEW_REQUIRED',
  message: String(r.message_template_ru),
  source: String(r.source_reference),
  enabled: false,
  validation_status: String(r.validation_status),
}));
write('contraindications', {
  package_type: 'contraindication_ruleset',
  version: '0.1.0',
  status: 'DRAFT',
  rules: ci,
});
write('interactions', { package_type: 'interaction_ruleset', version: '0.1.0', status: 'DRAFT', rules: ddi });
write('dosing', {
  package_type: 'dose_ruleset',
  version: '0.1.0',
  status: 'DRAFT',
  rules: [],
  profiles: rows(read('04_dose_architecture_mock_v0.1.0').DoseProfiles),
  policy: 'USE_BASE_REGIMEN',
});
write('manifest', {
  version: '0.1.0',
  clinical_hash: clinical.ruleset_hash,
  source_hash: hashContent(read('clinical-rules')),
  nodes: clinical.nodes.length,
  edges: clinical.edges.length,
  facts: clinical.fact_definitions.length,
  options: clinical.treatment_options.length,
  drugs: drugs.length,
  medical_approval: false,
  normalizations: [
    'FORMALIZED_ZERO_NONZERO → FORMALIZED_COMPOSITE_FROM_SOURCE_TEXT (метаданные с сохранением исходного статуса)',
    'AB-N002 input_ref: обозначение составного выражения перенесено в notes; все клинические ссылки находятся в AST',
    'EXCLUDE → BLOCK; KEEP_WITH_WARNING/WARNING → WARN; mock enabled=false',
  ],
});
console.log(
  `Проверено: ${clinical.nosologies.length} нозологий, ${clinical.nodes.length} узлов, ${clinical.edges.length} переходов, ${clinical.treatment_options.length} лекарственных вариантов. Статус DRAFT; SHA-256 ${clinical.ruleset_hash}`,
);
