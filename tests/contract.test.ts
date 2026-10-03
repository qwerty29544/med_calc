import { it, expect } from 'vitest';
import source from '../content/source/clinical-rules.json';
import exampleRequest from '../examples/evaluation-request.example.json';
import exampleResult from '../examples/evaluation-result.example.json';
import { validateContract, coreEnvelope } from '../packages/clinical/src/contract-validation';
import { compileAuthoring } from '../packages/clinical/src/compiler';
import { evaluate } from '../packages/clinical/src/engine';
import type { FactValue } from '../packages/contracts/src';
it('принимает нормативные примеры запроса и результата', () => {
  expect(validateContract('evaluation-request', exampleRequest).valid).toBe(true);
  expect(validateContract('evaluation-result', exampleResult).valid).toBe(true);
});
it('собственный trace соответствует evaluation-result schema', () => {
  const p = compileAuthoring(source);
  const core = evaluate(
    p,
    {
      id: 'test',
      nosology_code: 'CHRON_BRONCHITIS',
      facts: exampleRequest.case_snapshot.facts as Record<string, FactValue>,
      medications: { state: 'KNOWN_NONE', drug_ids: [], unrecognized: [] },
    },
    { allowDraft: true },
  );
  const result = coreEnvelope(core, p, {
    evaluation_id: 'test',
    request_id: 'test',
    started_at: '2026-10-02T00:00:00Z',
    finished_at: '2026-10-02T00:00:00Z',
  });
  expect(validateContract('evaluation-result', result).errors).toEqual([]);
});
