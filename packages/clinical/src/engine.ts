import type { CaseDraft, CoreResult, FactValue, RuleEdge, RulePackage, TraceStep } from '../../contracts/src';
import { evaluateExpression, references } from './expression';
import { hashRules } from './hash';

export function evaluate(
  rules: RulePackage,
  draft: CaseDraft,
  options: { allowDraft?: boolean; maxSteps?: number } = {},
): CoreResult {
  const result: CoreResult = {
    status: 'FAILED',
    outcome: null,
    missing_facts: [],
    trace: [],
    errors: [],
    steps_executed: 0,
  };
  const fail = (code: string, message: string, node_id?: string) => {
    result.errors.push({ code, message, ...(node_id ? { node_id } : {}) });
    return result;
  };
  if (rules.contract_version !== '0.1.0' || !/^0\.1\.\d+$/.test(rules.ruleset_version))
    return fail('INTERNAL_ERROR', 'Несовместимая версия контракта');
  if (!options.allowDraft && rules.status !== 'PUBLISHED')
    return fail('RULESET_NOT_PUBLISHED', 'Для штатного расчета требуется опубликованный пакет');
  if (rules.ruleset_hash && hashRules(rules) !== rules.ruleset_hash)
    return fail('RULESET_HASH_MISMATCH', 'Контрольная сумма правил не совпадает');
  if (!draft.facts || typeof draft.facts !== 'object')
    return fail('INVALID_CASE', 'Отсутствуют факты пациента');
  const definitions = new Map(rules.fact_definitions.map((f) => [f.fact_code, f]));
  const facts: Record<string, FactValue> = {};
  for (const [code, v] of Object.entries(draft.facts)) {
    const f = definitions.get(code);
    if (!f) return fail('UNKNOWN_FACT_CODE', `Неизвестный признак ${code}`);
    if (!v || !['KNOWN', 'UNKNOWN', 'NOT_ASSESSED'].includes(v.state))
      return fail('INVALID_CASE', `Некорректное состояние ${code}`);
    if (v.state !== 'KNOWN') {
      if (v.value !== null) return fail('INVALID_CASE', `Неизвестное значение ${code} должно быть null`);
      facts[code] = v;
      continue;
    }
    const x = v.value;
    const numeric = ['INTEGER', 'DECIMAL'].includes(f.data_type);
    if (
      x === null ||
      (numeric &&
        (typeof x !== 'number' ||
          !Number.isFinite(x) ||
          (f.data_type === 'INTEGER' && !Number.isInteger(x)))) ||
      (f.data_type === 'BOOLEAN' && typeof x !== 'boolean') ||
      (['ENUM', 'STRING', 'DATE'].includes(f.data_type) && typeof x !== 'string') ||
      (f.data_type === 'ENUM' && !f.enum_values?.includes(String(x)))
    )
      return fail('FACT_TYPE_MISMATCH', `Некорректный тип ${code}`);
    if (
      numeric &&
      ((f.min_value != null && (x as number) < f.min_value) ||
        (f.max_value != null && (x as number) > f.max_value))
    )
      return fail('FACT_TYPE_MISMATCH', `Значение ${code} вне диапазона`);
    if ((v.unit != null && v.unit !== f.unit) || (numeric && f.unit && v.unit !== f.unit))
      return fail('FACT_TYPE_MISMATCH', `Некорректная единица ${code}: требуется ${f.unit}`);
    facts[code] = v;
  }
  for (const f of rules.fact_definitions) {
    if (
      facts[f.fact_code]?.state !== 'KNOWN' &&
      ['TREAT_AS_TRUE', 'TREAT_AS_FALSE'].includes(f.unknown_policy)
    )
      facts[f.fact_code] = { state: 'KNOWN', value: f.unknown_policy === 'TREAT_AS_TRUE', unit: f.unit };
  }
  const nosology = rules.nosologies.find((n) => n.nosology_code === draft.nosology_code && n.active);
  if (!nosology) return fail('INVALID_CASE', 'Нозология не найдена');
  const nodes = new Map(rules.nodes.map((n) => [n.node_id, n]));
  let nodeId = nosology.root_node_id;
  const maxSteps = Math.min(options.maxSteps ?? 100, 1000);
  for (let step = 1; step <= maxSteps; step++) {
    const node = nodes.get(nodeId);
    if (!node) return fail('MISSING_REFERENCE', 'Узел не найден', nodeId);
    result.steps_executed = step;
    const trace: TraceStep = {
      sequence: step,
      node_id: nodeId,
      node_type: node.node_type,
      status: 'EVALUATED',
      inputs: {},
      edge_evaluations: [],
    };
    result.trace.push(trace);
    if (node.node_type.startsWith('TERMINAL')) {
      trace.status = 'TERMINAL';
      result.status = 'COMPLETED';
      result.outcome =
        node.node_type === 'TERMINAL_SCHEME'
          ? { type: 'TREATMENT_SCHEME', scheme_id: node.output_ref! }
          : { type: 'TERMINAL_STATE', terminal_code: node.output_ref! };
      return result;
    }
    const edges = rules.edges
      .filter((e) => e.from_node_id === nodeId)
      .sort((a, b) => a.priority - b.priority || (a.edge_id < b.edge_id ? -1 : 1));
    const refs = edges.flatMap((e) => references(e.condition));
    const scores: Record<string, number | null> = {};
    const scoreMissing: Record<string, string[]> = {};
    const details: Record<string, unknown> = {};
    for (const ref of refs.filter((r) => r.type === 'SCORE')) {
      if (ref.id in scores) continue;
      const group = rules.score_groups.find((s) => s.score_group_id === ref.id);
      if (!group) return fail('MISSING_REFERENCE', 'Группа баллов не найдена', nodeId);
      const items = group.items.map((item) => {
        const r = evaluateExpression(item.condition, facts);
        for (const f of references(item.condition))
          trace.inputs![f.id] = draft.facts[f.id] ?? { state: 'NOT_ASSESSED', value: null };
        return {
          item_id: item.item_id,
          label_ru: item.label_ru,
          weight: item.weight,
          result: r.value,
          contribution: r.value === null ? null : r.value === true ? item.weight : 0,
          missing: r.missing,
        };
      });
      scores[ref.id] = items.some((i) => i.result === null && i.weight !== 0)
        ? null
        : items.reduce((sum, i) => sum + (i.contribution ?? 0), 0);
      scoreMissing[ref.id] = [
        ...new Set(items.filter((i) => i.result === null && i.weight !== 0).flatMap((i) => i.missing)),
      ];
      details[ref.id] = { label_ru: group.label_ru, total: scores[ref.id], items };
    }
    trace.score_details = details;
    for (const f of refs.filter((r) => r.type !== 'SCORE'))
      trace.inputs![f.id] = draft.facts[f.id] ?? { state: 'NOT_ASSESSED', value: null };
    const evaluations = edges.map((e) => ({
      edge: e,
      result: evaluateExpression(e.condition, facts, scores),
    }));
    trace.edge_evaluations = evaluations.map((e) => ({
      edge_id: e.edge.edge_id,
      result: e.result.value === null ? 'UNKNOWN' : e.result.value === true ? 'TRUE' : 'FALSE',
      selected: false,
    }));
    const matches = evaluations.filter((e) => e.result.value === true);
    if (matches.length > 1) return fail('AMBIGUOUS_BRANCH', 'Одновременно выбраны несколько ветвей', nodeId);
    let selected: RuleEdge | undefined = matches[0]?.edge;
    if (!selected) {
      const unknown = evaluations.filter((e) => e.result.value === null);
      if (unknown.length) {
        if (node.unknown_behavior === 'USE_DEFAULT_EDGE') selected = edges.find((e) => e.is_default);
        if (!selected) {
          result.status = 'NEEDS_INPUT';
          trace.status = 'BLOCKED_MISSING_INPUT';
          result.missing_facts = [
            ...new Set(
              unknown.flatMap((e) => [
                ...e.result.missing,
                ...references(e.edge.condition)
                  .filter((r) => r.type === 'SCORE')
                  .flatMap((r) => scoreMissing[r.id] ?? []),
              ]),
            ),
          ].sort();
          return result;
        }
      }
      if (!selected) return fail('NO_BRANCH_MATCH', 'Нет подходящей ветви для введенных данных', nodeId);
    }
    trace.selected_edge_id = selected.edge_id;
    trace.next_node_id = selected.to_node_id;
    trace.edge_evaluations.find((e) => e.edge_id === selected!.edge_id)!.selected = true;
    nodeId = selected.to_node_id;
  }
  return fail('STEP_LIMIT_EXCEEDED', 'Превышен лимит шагов вычисления', nodeId);
}
