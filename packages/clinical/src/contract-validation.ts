import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import patient from '../../../schemas/patient-case.schema.json';
import request from '../../../schemas/evaluation-request.schema.json';
import result from '../../../schemas/evaluation-result.schema.json';
import rules from '../../../schemas/rule-package.schema.json';
import type { CoreResult, RulePackage } from '../../contracts/src';
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
for (const schema of [patient, rules, request, result]) ajv.addSchema(schema);
export function validateContract(
  kind: 'patient-case' | 'evaluation-request' | 'evaluation-result',
  value: unknown,
) {
  const check = ajv.getSchema(`urn:cdss:rule-engine:${kind}:0.1.0`)!;
  const valid = check(value);
  return { valid, errors: structuredClone(check.errors ?? []) };
}
export function coreEnvelope(
  core: CoreResult,
  rules: RulePackage,
  metadata: { evaluation_id: string; request_id: string; started_at: string; finished_at: string },
) {
  return {
    contract_version: '0.1.0',
    ...metadata,
    ruleset_version: rules.ruleset_version,
    ruleset_hash: rules.ruleset_hash ?? null,
    ...core,
    engine_metadata: { engine_version: '0.1.0' },
  };
}
