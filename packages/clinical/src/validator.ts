import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import schema from '../../../schemas/rule-package.schema.json';
import registry from '../../../content/source/01_drug_registry_v0.1.0.json';
import type { Expression, FactValue, RuleEdge, RulePackage, ValidationReport } from '../../contracts/src';
import { evaluateExpression, references } from './expression';
import { hashRules, canonicalJson } from './hash';
import { drugIdFromSourceText } from './drug-binding';
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const structural = ajv.compile(schema);
const defaultDrugIds = new Set(registry.Drugs.slice(1).map((r) => Number(r[0])));

export function validatePackage(payload: unknown): ValidationReport {
  const report: ValidationReport = { valid: false, errors: [], warnings: [] };
  const error = (code: string, message: string, path?: string) =>
    report.errors.push({ code, message, ...(path ? { path } : {}) });
  if (!structural(payload)) {
    for (const e of structural.errors ?? [])
      error('SCHEMA_ERROR', `${e.instancePath} ${e.message}`, e.instancePath);
    return report;
  }
  const p = payload as unknown as RulePackage;
  if (p.ruleset_hash && p.ruleset_hash !== hashRules(p))
    error('HASH_MISMATCH', 'SHA-256 не соответствует содержимому');
  if (p.status === 'PUBLISHED' && !p.ruleset_hash)
    error('MISSING_HASH', 'Опубликованный пакет требует SHA-256');
  for (const [key, version] of Object.entries(p.component_versions)) {
    const compatible =
      key === 'clinical_rules'
        ? /^0\.1\.\d+$/.test(version) && version === p.ruleset_version
        : version === '0.1.0';
    if (!compatible)
      error(
        'INCOMPATIBLE_VERSION',
        key === 'clinical_rules'
          ? `Версия clinical_rules ${version} должна совпадать с ruleset_version ${p.ruleset_version} в линии 0.1.x`
          : `Недоступна совместимая версия ${key}: ${version}`,
      );
  }
  const unique = <T>(xs: T[], key: (x: T) => string) => {
    const seen = new Set<string>();
    for (const x of xs) {
      const id = key(x);
      if (seen.has(id)) error('DUPLICATE_ID', `Повтор идентификатора ${id}`);
      seen.add(id);
    }
  };
  unique(p.nodes, (n) => n.node_id);
  unique(p.edges, (e) => e.edge_id);
  unique(p.fact_definitions, (f) => f.fact_code);
  unique(p.score_groups, (s) => s.score_group_id);
  unique(p.schemes, (s) => s.scheme_id);
  unique(p.nosologies, (n) => n.nosology_code);
  unique(p.treatment_options, (t) => t.treatment_option_id);
  const nodes = new Map(p.nodes.map((n) => [n.node_id, n]));
  const facts = new Map(p.fact_definitions.map((f) => [f.fact_code, f]));
  const scores = new Map(p.score_groups.map((s) => [s.score_group_id, s]));
  const schemes = new Map(p.schemes.map((s) => [s.scheme_id, s]));
  const terminals = new Set(p.terminal_states.map((t) => t.terminal_code));
  const outgoing = new Map<string, RuleEdge[]>();
  for (const e of p.edges) {
    const from = nodes.get(e.from_node_id),
      to = nodes.get(e.to_node_id);
    if (!from || !to) error('MISSING_REFERENCE', `Не найден узел ребра ${e.edge_id}`);
    else if (from.nosology_code !== e.nosology_code || to.nosology_code !== e.nosology_code)
      error('CROSS_NOSOLOGY', `Переход между нозологиями ${e.edge_id}`);
    outgoing.set(e.from_node_id, [...(outgoing.get(e.from_node_id) ?? []), e]);
  }
  function checkType(e: Expression, path: string, depth = 0): string {
    if (depth > 64) {
      error('AST_DEPTH', `Глубина AST превышена: ${path}`);
      return 'invalid';
    }
    if (e.kind === 'LITERAL') return typeof e.value;
    if (e.kind === 'REF') {
      if (e.ref_type === 'SCORE') {
        if (!scores.has(e.ref_id)) error('UNKNOWN_SCORE', e.ref_id, path);
        return 'number';
      }
      const f = facts.get(e.ref_id);
      if (!f) {
        error('UNKNOWN_FACT', e.ref_id, path);
        return 'invalid';
      }
      return ['INTEGER', 'DECIMAL'].includes(f.data_type)
        ? 'number'
        : f.data_type === 'BOOLEAN'
          ? 'boolean'
          : 'string';
    }
    const ts = e.operands.map((v) => checkType(v, path, depth + 1));
    const n = ts.length;
    if (
      (['NOT', 'IS_KNOWN', 'IS_UNKNOWN'].includes(e.operator) && n !== 1) ||
      (['EQ', 'NEQ', 'GT', 'GTE', 'LT', 'LTE'].includes(e.operator) && n !== 2) ||
      (e.operator === 'BETWEEN' && n !== 3) ||
      (['IN', 'NOT_IN'].includes(e.operator) && n < 2)
    )
      error('ARITY', `Неверное число аргументов ${e.operator}`, path);
    if (['AND', 'OR', 'NOT'].includes(e.operator)) {
      if (ts.some((t) => t !== 'boolean')) error('TYPE_MISMATCH', `Ожидается BOOLEAN в ${e.operator}`, path);
    } else if (!['IS_KNOWN', 'IS_UNKNOWN'].includes(e.operator)) {
      if (ts.some((t) => t !== ts[0])) error('TYPE_MISMATCH', `Несовместимые типы ${ts.join(',')}`, path);
      if (['GT', 'GTE', 'LT', 'LTE', 'BETWEEN'].includes(e.operator) && ts[0] !== 'number')
        error('TYPE_MISMATCH', `Сравнение требует числа`, path);
    }
    const ref = e.operands.find((o) => o.kind === 'REF' && o.ref_type === 'FACT');
    if (ref?.kind === 'REF') {
      const f = facts.get(ref.ref_id);
      for (const literal of e.operands) {
        if (literal.kind === 'LITERAL' && literal.unit && literal.unit !== f?.unit)
          error('UNIT_MISMATCH', `Единица ${literal.unit} не соответствует ${f?.unit}`, path);
      }
    }
    return 'boolean';
  }
  for (const s of p.score_groups) {
    unique(s.items, (i) => i.item_id);
    for (const i of s.items) {
      if (checkType(i.condition, i.item_id) !== 'boolean') error('SCORE_TYPE', i.item_id);
      if (references(i.condition).some((r) => r.type !== 'FACT'))
        error('SCORE_REFERENCE', 'Баллы 0.1.0 допускают только ссылки на факты', i.item_id);
    }
  }
  for (const e of p.edges)
    if (checkType(e.condition, e.edge_id) !== 'boolean')
      error('EDGE_TYPE', `Условие ${e.edge_id} не BOOLEAN`);
  const state = new Map<string, number>();
  const reached = new Set<string>();
  const visit = (id: string) => {
    if (state.get(id) === 1) {
      error('CYCLE', `Цикл в ${id}`);
      return;
    }
    if (state.get(id) === 2) return;
    state.set(id, 1);
    reached.add(id);
    for (const e of outgoing.get(id) ?? []) if (nodes.has(e.to_node_id)) visit(e.to_node_id);
    state.set(id, 2);
  };
  for (const n of p.nosologies) {
    const root = nodes.get(n.root_node_id);
    if (!root || root.nosology_code !== n.nosology_code) error('INVALID_ROOT', n.nosology_code);
    else visit(n.root_node_id);
  }
  for (const n of p.nodes) {
    if (!reached.has(n.node_id)) error('UNREACHABLE', n.node_id);
    const edges = outgoing.get(n.node_id) ?? [];
    if (!p.nosologies.some((x) => x.nosology_code === n.nosology_code)) error('UNKNOWN_NOSOLOGY', n.node_id);
    if (n.node_type.startsWith('TERMINAL')) {
      if (edges.length) error('TERMINAL_EDGE', n.node_id);
      if (n.node_type === 'TERMINAL_SCHEME') {
        const scheme = schemes.get(n.output_ref ?? '');
        if (!scheme) error('UNKNOWN_SCHEME', n.node_id);
        else if (scheme.nosology_code !== n.nosology_code)
          error(
            'CROSS_NOSOLOGY',
            `Узел ${n.node_id} ссылается на схему ${scheme.scheme_id} другой нозологии`,
          );
      }
      if (n.node_type === 'TERMINAL_STATE' && !terminals.has(n.output_ref ?? ''))
        error('UNKNOWN_TERMINAL', n.node_id);
    } else {
      if (!edges.length) error('NO_EDGES', n.node_id);
      if (n.input_ref && !facts.has(n.input_ref) && !scores.has(n.input_ref))
        error('UNKNOWN_INPUT', n.node_id);
      if (n.unknown_behavior === 'USE_DEFAULT_EDGE' && edges.filter((e) => e.is_default).length !== 1)
        error('INVALID_DEFAULT_EDGE', n.node_id);
    }
  }
  for (const t of p.treatment_options) {
    if (!schemes.has(t.scheme_id)) error('UNKNOWN_SCHEME', t.scheme_id);
    if (!defaultDrugIds.has(t.drug_id)) error('UNKNOWN_DRUG', String(t.drug_id));
    const sourceDrugId = drugIdFromSourceText(t.base_regimen_text);
    if (sourceDrugId !== undefined && sourceDrugId !== t.drug_id)
      error(
        'DRUG_REGIMEN_MISMATCH',
        `Режим ${t.treatment_option_id} относится к препарату ${sourceDrugId}, указан ${t.drug_id}`,
      );
    else if (sourceDrugId === undefined)
      report.warnings.push({
        code: 'DRUG_REGIMEN_REVIEW_REQUIRED',
        message: `МНН в режиме ${t.treatment_option_id} не распознано; требуется отдельная проверка источника.`,
      });
  }
  for (const s of p.schemes) {
    if (!p.nosologies.some((n) => n.nosology_code === s.nosology_code))
      error('UNKNOWN_NOSOLOGY', s.scheme_id);
    if (!s.terminal_state_override && !p.treatment_options.some((t) => t.scheme_id === s.scheme_id))
      error('EMPTY_SCHEME', s.scheme_id);
  }
  if (report.errors.length === 0)
    for (const n of p.nodes.filter((n) => !n.node_type.startsWith('TERMINAL'))) {
      const edges = outgoing.get(n.node_id) ?? [];
      const refs = [
        ...new Map(
          edges.flatMap((e) => references(e.condition)).map((r) => [`${r.type}:${r.id}`, r]),
        ).values(),
      ];
      const domains = refs.map((r) => {
        if (r.type === 'SCORE') {
          let values = new Set([0]);
          for (const i of scores.get(r.id)!.items)
            values = new Set([...values, ...[...values].map((v) => v + i.weight)]);
          return [...values];
        }
        const f = facts.get(r.id)!;
        if (f.data_type === 'BOOLEAN') return [false, true];
        if (f.data_type === 'ENUM') return f.enum_values ?? [];
        const values = new Set<number | string>();
        const boundaries = new Set<number>();
        const find = (e: Expression) => {
          if (e.kind !== 'OP') return;
          if (e.operands.some((v) => v.kind === 'REF' && v.ref_id === r.id)) {
            for (const x of e.operands)
              if (x.kind === 'LITERAL') {
                if (typeof x.value === 'number') {
                  boundaries.add(x.value);
                  const delta = f.data_type === 'INTEGER' ? 1 : 0.001;
                  [x.value - delta, x.value, x.value + delta].forEach((v) => values.add(v));
                } else if (typeof x.value === 'string') values.add(x.value);
              }
          }
          e.operands.forEach(find);
        };
        edges.forEach((e) => find(e.condition));
        if (f.data_type === 'DECIMAL') {
          // Одна проба внутри каждого открытого промежутка выявляет даже интервалы уже 0.001.
          if (f.min_value != null) boundaries.add(f.min_value);
          if (f.max_value != null) boundaries.add(f.max_value);
          const sorted = [...boundaries].sort((a, b) => a - b);
          sorted.forEach((v) => values.add(v));
          for (let i = 1; i < sorted.length; i++) {
            const lower = sorted[i - 1]!,
              upper = sorted[i]!;
            const midpoint = lower / 2 + upper / 2;
            if (midpoint > lower && midpoint < upper) values.add(midpoint);
          }
        }
        if (!values.size) values.add(f.data_type === 'STRING' ? '' : 0);
        return [...values].filter(
          (v) =>
            typeof v !== 'number' ||
            ((f.min_value == null || v >= f.min_value) && (f.max_value == null || v <= f.max_value)),
        );
      });
      const count = domains.reduce((a, b) => a * b.length, 1);
      if (count > 20000) {
        error('COVERAGE_LIMIT', `Невозможно исчерпывающе проверить ${n.node_id}: ${count} комбинаций`);
        continue;
      }
      let flagged = false;
      const walk = (i: number, fs: Record<string, FactValue>, ss: Record<string, number | null>) => {
        if (flagged) return;
        if (i === refs.length) {
          const matches = edges.filter((e) => evaluateExpression(e.condition, fs, ss).value === true);
          if (matches.length !== 1) {
            error(
              matches.length > 1 ? 'AMBIGUOUS_BRANCH' : 'COVERAGE_GAP',
              `${n.node_id}: ${matches.length} истинных ветвей при ${canonicalJson({ ...fs, ...ss })}`,
            );
            flagged = true;
          }
          return;
        }
        const r = refs[i]!;
        for (const value of domains[i] ?? []) {
          if (r.type === 'SCORE') ss[r.id] = value as number;
          else fs[r.id] = { state: 'KNOWN', value };
          walk(i + 1, fs, ss);
        }
      };
      walk(0, {}, {});
    }
  for (const n of p.nodes)
    if (n.resolution_status === 'NORMALIZED_SOURCE_TYPO_PENDING_CONFIRMATION')
      report.warnings.push({
        code: 'CLINICAL_CONFIRMATION_REQUIRED',
        message: `Требуется подтверждение нормализации ${n.node_id}`,
      });
  if (p.status !== 'PUBLISHED')
    report.warnings.push({
      code: 'UNPUBLISHED_CONTENT',
      message: 'Пакет не опубликован; допустим только демонстрационный запуск.',
    });
  report.valid = report.errors.length === 0;
  return report;
}
