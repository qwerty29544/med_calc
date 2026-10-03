import { performance } from 'node:perf_hooks';
import { loadContent } from '../packages/clinical/src/service';
import { evaluate } from '../packages/clinical/src/engine';
import example from '../examples/evaluation-request.example.json';
import type { CaseDraft, FactValue } from '../packages/contracts/src';
const content = loadContent();
const sample: CaseDraft = {
  id: 'benchmark',
  nosology_code: 'CHRON_BRONCHITIS',
  facts: example.case_snapshot.facts as Record<string, FactValue>,
  medications: { state: 'KNOWN_NONE', drug_ids: [], unrecognized: [] },
};
const timings: number[] = [];
for (let i = 0; i < 110; i++) {
  const t = performance.now();
  const r = evaluate(content.rules, sample, { allowDraft: true });
  if (r.status !== 'COMPLETED') throw new Error('Benchmark sample failed');
  if (i >= 10) timings.push(performance.now() - t);
}
timings.sort((a, b) => a - b);
console.log(
  JSON.stringify(
    {
      scope: 'warm clinical core, sample CB_S1_R1, with hashing and trace',
      runs: timings.length,
      p50_ms: timings[50],
      p95_ms: timings[95],
      max_ms: timings.at(-1),
    },
    null,
    2,
  ),
);
