import type { Expression, FactValue } from '../../contracts/src';
export interface ExpressionResult {
  value: boolean | number | string | null;
  missing: string[];
}
export function evaluateExpression(
  expr: Expression,
  facts: Record<string, FactValue>,
  scores: Record<string, number | null> = {},
  depth = 0,
): ExpressionResult {
  if (depth > 64) throw new Error('AST_DEPTH_EXCEEDED');
  if (expr.kind === 'LITERAL') return { value: expr.value, missing: [] };
  if (expr.kind === 'REF') {
    if (expr.ref_type === 'SCORE') return { value: scores[expr.ref_id] ?? null, missing: [] };
    const f = facts[expr.ref_id];
    return f?.state === 'KNOWN' ? { value: f.value, missing: [] } : { value: null, missing: [expr.ref_id] };
  }
  const args = expr.operands.map((a) => evaluateExpression(a, facts, scores, depth + 1));
  const values = args.map((a) => a.value);
  const missing = [...new Set(args.flatMap((a) => a.missing))].sort();
  const result = (value: ExpressionResult['value']): ExpressionResult => ({
    value,
    missing: value === null ? missing : [],
  });
  switch (expr.operator) {
    case 'AND':
      return result(
        values.includes(false) ? false : values.includes(null) ? null : values.every((v) => v === true),
      );
    case 'OR':
      return result(values.includes(true) ? true : values.includes(null) ? null : false);
    case 'NOT':
      return result(values[0] === null ? null : !values[0]);
    case 'IS_KNOWN':
      return result(values[0] !== null);
    case 'IS_UNKNOWN':
      return result(values[0] === null);
  }
  if (values.includes(null)) return result(null);
  const a = values[0]!,
    b = values[1]!;
  switch (expr.operator) {
    case 'EQ':
      return result(a === b);
    case 'NEQ':
      return result(a !== b);
    case 'GT':
      return result(a > b);
    case 'GTE':
      return result(a >= b);
    case 'LT':
      return result(a < b);
    case 'LTE':
      return result(a <= b);
    case 'IN':
      return result(values.slice(1).includes(a));
    case 'NOT_IN':
      return result(!values.slice(1).includes(a));
    case 'BETWEEN':
      return result(a >= b && a <= values[2]!);
    default:
      throw new Error(`Неизвестный оператор ${expr.operator}`);
  }
}
export function references(expr: Expression): { type: 'FACT' | 'SCORE' | 'DERIVED_FACT'; id: string }[] {
  return expr.kind === 'REF'
    ? [{ type: expr.ref_type, id: expr.ref_id }]
    : expr.kind === 'OP'
      ? expr.operands.flatMap(references)
      : [];
}
