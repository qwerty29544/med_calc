import { it, expect } from 'vitest';
import authoring from '../content/source/clinical-rules.json';
import workbook from '../content/source/clinical_rules_v0.1.0.json';
function objects(rows: unknown[][]): Record<string, unknown>[] {
  return rows
    .slice(1)
    .map((row) => Object.fromEntries(rows[0]!.map((header, i) => [String(header), row[i]])));
}
const normalized = (value: unknown) => (value === '' ? null : value);
it('входные JSON и XLSX согласованы по всем условиям и переходам', () => {
  const rows = objects(workbook.Edges);
  const edges = Object.values(authoring.nosologies).flatMap((n) => n.edges);
  expect(rows).toHaveLength(edges.length);
  for (const row of rows) {
    const edge = edges.find((e) => e.edge_id === row.edge_id);
    expect(edge).toBeDefined();
    for (const key of [
      'from_node_id',
      'to_node_id',
      'branch_expression',
      'priority',
      'resolution_status',
    ] as const)
      expect(normalized(row[key])).toEqual(normalized(edge![key]));
  }
});
it('входные JSON и XLSX согласованы по текстам схем и исходным drug_ids', () => {
  const rows = objects(workbook.TreatmentOutputs);
  expect(rows).toHaveLength(authoring.treatment_outputs.length);
  for (let i = 0; i < rows.length; i++)
    for (const key of ['scheme_or_terminal_id', 'regimen_text_source', 'drug_ids', 'line_type'] as const)
      expect(normalized(rows[i]![key])).toEqual(normalized(authoring.treatment_outputs[i]![key]));
});
