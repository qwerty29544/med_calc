import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  CaseDraft,
  ClinicalContent,
  CoreResult,
  EvaluationView,
  FactDefinition,
  RulePackage,
} from '../../contracts/src';
import { evaluate } from './engine';
import { hashContent, hashRules } from './hash';
import { validatePackage } from './validator';
import { resolveTherapy } from '../../therapy/src';
import { optionText } from './composer';
export { validatePackage } from './validator';
export { compileAuthoring } from './compiler';

/** I/O оболочка: runtime читает только заранее скомпилированные пакеты. */
export function loadContent(root = process.cwd()): ClinicalContent {
  const read = (name: string) =>
    JSON.parse(readFileSync(resolve(root, 'content/canonical', name + '.json'), 'utf8'));
  const rules = read('clinical-rules') as RulePackage;
  const report = validatePackage(rules);
  if (!report.valid) throw new Error(`CONTENT_VALIDATION_ERROR: ${JSON.stringify(report.errors)}`);
  const registry = read('drug-registry'),
    ci = read('contraindications'),
    ddi = read('interactions'),
    dosing = read('dosing');
  return {
    rules,
    drugs: registry.drugs,
    contraindications: ci.rules,
    interactions: ddi.rules,
    dose_rules: dosing.rules,
    hashes: {
      clinical_rules: hashRules(rules),
      drug_registry: hashContent(registry),
      contraindications: hashContent(ci),
      interactions: hashContent(ddi),
      dose_rules: hashContent(dosing),
    },
    demo: rules.status !== 'PUBLISHED',
  };
}
export function formDefinition(f: FactDefinition): FactDefinition {
  return {
    ...f,
    ...(f.fact_code === 'AGE_YEARS'
      ? { min_value: 18, max_value: 120 }
      : ['INTEGER', 'DECIMAL'].includes(f.data_type)
        ? { min_value: 0, ...(f.unit === '%' ? { max_value: 100 } : {}) }
        : {}),
  };
}
export function preview(content: ClinicalContent, draft: CaseDraft): EvaluationView {
  const { rules } = content;
  const age = draft.facts.AGE_YEARS;
  let core: CoreResult;
  // Ограничение области применения не меняет нозологическое дерево.
  const invalid = Object.entries(draft.facts).find(([code, v]) => {
    const f = rules.fact_definitions.find((f) => f.fact_code === code);
    if (!f || v.state !== 'KNOWN') return false;
    const def = formDefinition(f);
    return (
      typeof v.value === 'number' &&
      ((def.min_value != null && v.value < def.min_value) ||
        (def.max_value != null && v.value > def.max_value))
    );
  });
  if (invalid)
    core = {
      status: 'FAILED',
      outcome: null,
      missing_facts: [],
      trace: [],
      errors: [
        {
          code: 'FACT_TYPE_MISMATCH',
          message: 'Значение вне допустимого диапазона. Калькулятор предназначен для взрослых от 18 лет.',
        },
      ],
      steps_executed: 0,
    };
  else if (!age || age.state !== 'KNOWN')
    core = {
      status: 'NEEDS_INPUT',
      outcome: null,
      missing_facts: ['AGE_YEARS'],
      trace: [],
      errors: [],
      steps_executed: 0,
    };
  else core = evaluate(rules, draft, { allowDraft: content.demo });
  const view: EvaluationView = {
    case_id: draft.id,
    nosology_code: draft.nosology_code,
    status: core.status,
    missing_facts: core.missing_facts,
    questions: core.missing_facts
      .map((code) => rules.fact_definitions.find((f) => f.fact_code === code))
      .filter((f): f is FactDefinition => !!f)
      .map(formDefinition),
    outcome: core.outcome,
    title: '',
    options: [],
    warnings: [],
    explanation: [],
    copy_text: '',
    trace: [...core.trace],
    versions: {
      application: '0.1.0',
      rule_engine: '0.1.0',
      ...rules.component_versions,
      ...content.versions,
    },
    hashes: { ...content.hashes, clinical_rules: hashRules(rules) },
    demo: content.demo,
    safety_status: 'NOT_APPLICABLE',
    errors: core.errors,
  };
  if (content.demo)
    view.warnings.push(
      'Демонстрационный расчет: медицинский пакет DRAFT не утвержден для клинического применения.',
    );
  if (core.status === 'NEEDS_INPUT') view.title = 'Необходимы дополнительные данные';
  else if (core.status === 'FAILED') {
    view.title = 'Расчет не выполнен';
    view.warnings.push(...core.errors.map((e) => e.message));
  } else if (core.outcome?.type === 'TREATMENT_SCHEME') {
    const therapy = resolveTherapy(content, core.outcome.scheme_id, draft);
    view.options = therapy.options;
    view.warnings.push(
      ...therapy.warnings,
      ...therapy.options.flatMap((o) =>
        o.findings.filter((f) => f.action !== 'ALLOW').map((f) => `${o.drug_name}: ${f.message}`),
      ),
    );
    view.warnings = [...new Set(view.warnings)];
    view.safety_status = therapy.safety_status;
    view.trace.push(...therapy.trace);
    if (!therapy.options.length) {
      view.status = 'FAILED';
      view.title = 'Схема не содержит лекарственных вариантов';
      view.errors = [{ code: 'MISSING_REFERENCE', message: view.title }];
    } else if (therapy.options.every((o) => o.eligibility === 'BLOCKED')) {
      view.outcome = { type: 'TERMINAL_STATE', terminal_code: 'NO_APPLICABLE_DRUG' };
      view.title = 'Нет применимого препарата для автоматической рекомендации';
    } else
      view.title = therapy.options.some((o) => o.eligibility === 'ELIGIBLE')
        ? 'Схема терапии сформирована'
        : 'Схема сформирована; требуется оценка врача';
  }
  if (view.outcome?.type === 'TERMINAL_STATE')
    view.title =
      rules.terminal_states.find(
        (t) =>
          t.terminal_code === (view.outcome?.type === 'TERMINAL_STATE' ? view.outcome.terminal_code : ''),
      )?.label_ru ?? view.title;
  for (const step of core.trace) {
    const node = rules.nodes.find((n) => n.node_id === step.node_id);
    if (step.status === 'TERMINAL') {
      view.explanation.push(node?.label_ru ?? 'Дерево завершено');
      continue;
    }
    const used = Object.entries(step.inputs ?? {}).map(([code, v]) => {
      const f = rules.fact_definitions.find((f) => f.fact_code === code);
      const value = v as { state: string; value: unknown };
      return `${f?.label_ru ?? code}: ${value.state !== 'KNOWN' ? 'неизвестно' : value.value === true ? 'да' : value.value === false ? 'нет' : String(value.value)}`;
    });
    view.explanation.push(
      `${node?.label_ru ?? 'Клинический шаг'}. ${used.join('; ')}${step.status === 'BLOCKED_MISSING_INPUT' ? '. Требуется уточнение.' : ''}`,
    );
  }
  const name =
    rules.nosologies.find((n) => n.nosology_code === draft.nosology_code)?.name_ru ?? draft.nosology_code;
  const lines: Record<string, string> = {
    FIRST_LINE: 'Первая линия',
    ALTERNATIVE_1: 'Альтернатива 1',
    ALTERNATIVE_2: 'Альтернатива 2',
    ALTERNATIVE_3: 'Альтернатива 3',
    OTHER: 'Вариант',
  };
  view.copy_text = [
    content.demo
      ? 'Демонстрационный расчет. Медицинский пакет не утвержден.'
      : 'Результат поддержки врачебного решения.',
    `Нозология: ${name}`,
    view.title,
    ...view.options
      .filter((o) => o.eligibility !== 'BLOCKED')
      .map((o) => `${lines[o.line] ?? o.line}: ${optionText(o)}`),
    ...view.warnings.map((w) => `Внимание: ${w}`),
    `Версии: ${Object.entries(view.versions)
      .map(([k, v]) => `${k} ${v}`)
      .join('; ')}`,
    `Источник: ${rules.provenance.source_basis.map((s) => s.document_id).join('; ')}`,
    `SHA-256 клинических правил: ${view.hashes.clinical_rules}`,
  ].join('\n');
  view.trace.push({
    stage: 'COMPOSITION',
    outcome: view.outcome,
    versions: view.versions,
    hashes: view.hashes,
  });
  return view;
}
