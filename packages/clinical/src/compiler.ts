import type { Expression, RulePackage, SourceRef } from '../../contracts/src';
import { hashRules } from './hash';
import { drugIdFromSourceText } from './drug-binding';
type Authoring = typeof import('../../../content/source/clinical-rules.json');

/** Белый список токенов; авторский текст никогда не является JavaScript. */
export function parseExpression(text: string): Expression {
  if (text.length > 10000) throw new Error('Выражение слишком длинное');
  const tokens: string[] = [];
  const re = /\s*(>=|<=|==|!=|>|<|\(|\)|-?\d+(?:\.\d+)?|'[^'\\]*'|[A-Za-z_][A-Za-z_0-9]*)/gy;
  let offset = 0;
  while (offset < text.length) {
    if (!text.slice(offset).trim()) break;
    re.lastIndex = offset;
    const m = re.exec(text);
    if (!m) throw new Error(`Недопустимый синтаксис: ${text.slice(offset, offset + 30)}`);
    tokens.push(m[1]!);
    offset = re.lastIndex;
  }
  let pos = 0,
    depth = 0;
  const peek = () => tokens[pos];
  const take = () => tokens[pos++];
  const need = (s: string) => {
    if (take() !== s) throw new Error(`Ожидалось ${s}`);
  };
  const op = (operator: string, ...operands: Expression[]): Expression => ({
    kind: 'OP',
    operator,
    operands,
  });
  function atom(): Expression {
    if (++depth > 64) throw new Error('Слишком глубокое выражение');
    let v: Expression;
    const t = take();
    if (t === '(') {
      v = or();
      need(')');
    } else if (t === 'score') {
      need('(');
      const id = take();
      if (!id || !/^[A-Z][A-Z0-9_]*$/.test(id)) throw new Error('Некорректная ссылка score');
      need(')');
      v = { kind: 'REF', ref_type: 'SCORE', ref_id: id };
    } else if (t === 'TRUE' || t === 'FALSE') v = { kind: 'LITERAL', value: t === 'TRUE' };
    else if (t?.startsWith("'")) v = { kind: 'LITERAL', value: t.slice(1, -1) };
    else if (t && /^-?\d+(\.\d+)?$/.test(t)) v = { kind: 'LITERAL', value: Number(t) };
    else if (t && /^[A-Z][A-Z0-9_]*$/.test(t)) v = { kind: 'REF', ref_type: 'FACT', ref_id: t };
    else throw new Error(`Неизвестный токен ${t}`);
    depth--;
    return v;
  }
  function comparison(): Expression {
    const a = atom();
    const codes: Record<string, string> = {
      '==': 'EQ',
      '!=': 'NEQ',
      '>': 'GT',
      '>=': 'GTE',
      '<': 'LT',
      '<=': 'LTE',
    };
    const c = codes[peek() ?? ''];
    return c ? (take(), op(c, a, atom())) : a;
  }
  function not(): Expression {
    if (peek() === 'NOT') {
      take();
      return op('NOT', not());
    }
    return comparison();
  }
  function and(): Expression {
    let a = not();
    while (peek() === 'AND') {
      take();
      a = op('AND', a, not());
    }
    return a;
  }
  function or(): Expression {
    let a = and();
    while (peek() === 'OR') {
      take();
      a = op('OR', a, and());
    }
    return a;
  }
  const result = or();
  if (pos !== tokens.length) throw new Error('Не все выражение разобрано');
  return result;
}

export function compileAuthoring(input: unknown): RulePackage {
  const a = input as Authoring;
  if (
    !a ||
    a.ruleset_version !== '0.1.0' ||
    !Array.isArray(a.variables) ||
    !a.nosologies ||
    !Array.isArray(a.treatment_outputs)
  )
    throw new Error('Неподдерживаемый формат authoring 0.1.0');
  const source = (slide?: number | null, note?: string): SourceRef => ({
    source_type: 'PRESENTATION',
    document_id: a.source.file,
    ...(slide ? { slide } : {}),
    ...(note ? { note } : {}),
  });
  const resolution = (status: string) =>
    status === 'FORMALIZED_ZERO_NONZERO' ? 'FORMALIZED_COMPOSITE_FROM_SOURCE_TEXT' : status;
  const notes = (status: string, note: string) =>
    status === 'FORMALIZED_ZERO_NONZERO'
      ? `${note} Исходный resolution_status=FORMALIZED_ZERO_NONZERO; метаданные сопоставлены с FORMALIZED_COMPOSITE_FROM_SOURCE_TEXT контракта 0.1.0; условия и веса сохранены.`
      : note;
  const p: RulePackage = {
    contract_version: '0.1.0',
    package_type: 'CLINICAL_RULESET',
    ruleset_version: a.ruleset_version,
    status: 'DRAFT',
    hash_algorithm: 'SHA-256',
    component_versions: {
      clinical_rules: '0.1.0',
      drug_registry: '0.1.0',
      contraindications: '0.1.0',
      interactions: '0.1.0',
      dose_rules: '0.1.0',
    },
    nosologies: Object.entries(a.nosologies).map(([nosology_code, n]) => ({
      nosology_code,
      name_ru: n.name_ru,
      root_node_id: n.root_node_id,
      active: true,
    })),
    fact_definitions: a.variables.map((v) => ({
      fact_code: v.fact_code,
      label_ru: v.label_ru,
      data_type: v.data_type as RulePackage['fact_definitions'][number]['data_type'],
      unit: v.unit,
      enum_values: v.enum_values,
      unknown_allowed: v.unknown_allowed,
      unknown_policy: v.unknown_behavior,
      notes: v.notes,
    })),
    score_groups: a.score_groups.map((g) => ({
      score_group_id: g.score_group_id,
      label_ru: g.label_ru,
      items: g.items.map((i, k) => ({
        item_id: `${g.score_group_id}_${k + 1}`,
        weight: i.weight,
        condition: parseExpression(i.item_expression),
        label_ru: a.variables.find((v) => v.fact_code === i.fact_code)?.label_ru ?? i.fact_code,
      })),
      source: source(g.source_slides[0]),
      resolution_status: resolution(g.resolution_status),
      notes: notes(g.resolution_status, g.notes),
    })),
    nodes: Object.values(a.nosologies).flatMap((n) =>
      n.nodes.map((v) => ({
        node_id: v.node_id,
        nosology_code: v.nosology_code,
        node_type: v.node_type,
        input_ref: v.node_type === 'COMPOSITE_DECISION' ? null : v.input_ref,
        output_ref: v.output_ref,
        label_ru: v.label_ru,
        unknown_behavior: v.unknown_behavior,
        resolution_status: resolution(v.resolution_status),
        source: source(v.source_slide),
        display_expression: v.expression,
        notes:
          notes(v.resolution_status, v.notes) +
          (v.node_type === 'COMPOSITE_DECISION'
            ? ` Исходный input_ref=${v.input_ref}: обозначение составного выражения; факты перечислены в AST ребер.`
            : ''),
      })),
    ),
    edges: Object.values(a.nosologies).flatMap((n) =>
      n.edges.map((e) => ({
        edge_id: e.edge_id,
        nosology_code: e.nosology_code,
        from_node_id: e.from_node_id,
        to_node_id: e.to_node_id,
        branch_code: e.branch_code,
        condition: parseExpression(e.branch_expression),
        priority: e.priority,
        resolution_status: e.resolution_status,
        source: source(e.source_slide),
        display_expression: e.branch_expression,
        notes: e.notes,
      })),
    ),
    schemes: a.scheme_map.map((s) => ({
      scheme_id: s.scheme_id,
      nosology_code: s.nosology_code,
      scheme_root: s.scheme_root,
      rank: s.rank,
      tree_label: s.tree_label,
      table_label: s.table_label,
      resolution_status: s.resolution_status,
      terminal_state_override: s.terminal_state_override,
      source: source(s.source_table_slide),
      notes: s.notes,
    })),
    terminal_states: a.terminal_state_catalog.map((s) => ({
      terminal_code: s.code,
      label_ru: s.label_ru,
      scope: s.code === 'NO_APPLICABLE_DRUG' ? 'PIPELINE' : 'CLINICAL_ENGINE',
    })),
    treatment_options: [],
    provenance: {
      source_basis: [source()],
      normalization_policy: a.policies.subscheme_mapping,
      notes: a.source.basis,
    },
  };
  const lines: Record<string, string> = {
    '1-я линия': 'FIRST_LINE',
    'Альтернатива 1': 'ALTERNATIVE_1',
    'Альтернатива 2': 'ALTERNATIVE_2',
    'Альтернатива 3': 'ALTERNATIVE_3',
    Альтернатива: 'ALTERNATIVE_1',
  };
  for (const t of a.treatment_outputs) {
    if (!t.drug_ids) continue;
    const ids = t.drug_ids.split(',').map(Number);
    const parts = t.regimen_text_source.split(/\s+или\s+(?=[А-ЯЁ][а-яё]+(?:\s|$))/u);
    if (parts.length !== ids.length)
      throw new Error(
        `Неоднозначный состав строки ${t.row_order}: ${ids.length} препаратов, ${parts.length} режимов`,
      );
    const bound = parts.map((part) => drugIdFromSourceText(part));
    if (bound.some((id) => id === undefined || !ids.includes(id)) || new Set(bound).size !== ids.length)
      throw new Error(
        `Неоднозначная связь имени и ID препарата: ${t.scheme_or_terminal_id}, строка ${t.row_order}`,
      );
    bound.forEach((drug_id, i) =>
      p.treatment_options.push({
        treatment_option_id: `${t.scheme_or_terminal_id}_${t.row_order}_${i + 1}`,
        scheme_id: t.scheme_or_terminal_id,
        line_type: lines[t.line_type] ?? 'OTHER',
        option_group: t.row_order,
        drug_id: drug_id!,
        base_regimen_text: parts[i]!,
        source: source(
          t.source_slide,
          drug_id !== ids[i]
            ? `Порядок drug_ids=${t.drug_ids} в исходной строке не соответствует названиям; ID ${drug_id} привязан по точному МНН из справочника.`
            : undefined,
        ),
      }),
    );
  }
  p.ruleset_hash = hashRules(p);
  return p;
}
