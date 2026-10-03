import { z } from 'zod';
import type { CaseDraft, ClinicalContent, FactValue, Medications } from '../../../packages/contracts/src';
import { formDefinition } from '../../../packages/clinical/src/service';
export class ApiError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function fail(status: number, code: string, message: string): never {
  throw new ApiError(status, code, message);
}
export const factSchema = z
  .strictObject({
    state: z.enum(['KNOWN', 'UNKNOWN', 'NOT_ASSESSED']),
    value: z.union([z.boolean(), z.number(), z.string().max(256), z.null()]),
    unit: z.string().max(32).nullable().optional(),
    source: z.enum(['MANUAL', 'IMPORTED', 'CALCULATED', 'UNKNOWN']).optional(),
  })
  .superRefine((f, ctx) => {
    if ((f.state === 'KNOWN' && f.value === null) || (f.state !== 'KNOWN' && f.value !== null))
      ctx.addIssue({
        code: 'custom',
        message: 'UNKNOWN и NOT_ASSESSED требуют null; KNOWN требует значение',
      });
    if (f.source === 'CALCULATED')
      ctx.addIssue({ code: 'custom', message: 'Вычисляемые факты недоступны для ручного ввода' });
  });
export const medicationsSchema = z
  .strictObject({
    state: z.enum(['UNKNOWN', 'KNOWN_NONE', 'KNOWN_LIST']),
    drug_ids: z.array(z.number().int().positive()).max(200),
    unrecognized: z.array(z.string().trim().min(1).max(160)).max(100),
  })
  .superRefine((m, ctx) => {
    if (
      (m.state !== 'KNOWN_LIST' && (m.drug_ids.length || m.unrecognized.length)) ||
      (m.state === 'KNOWN_LIST' && !m.drug_ids.length && !m.unrecognized.length) ||
      new Set(m.drug_ids).size !== m.drug_ids.length
    )
      ctx.addIssue({ code: 'custom', message: 'Состояние списка препаратов не соответствует содержимому' });
  });
export const factsSchema = z
  .record(z.string().max(100), factSchema)
  .refine((v) => Object.keys(v).length <= 500, 'Слишком много фактов');
export const draftPatch = z
  .strictObject({ facts: factsSchema.optional(), medications: medicationsSchema.optional() })
  .refine((v) => Object.keys(v).length > 0);
export const goldenSchema = z.strictObject({
  name: z.string().min(1).max(200),
  case: z.strictObject({
    nosology_code: z.string().min(1).max(80),
    facts: factsSchema,
    medications: medicationsSchema,
  }),
  expected: z.strictObject({
    status: z.enum(['COMPLETED', 'NEEDS_INPUT', 'FAILED']),
    outcome: z.union([
      z.strictObject({ type: z.literal('TREATMENT_SCHEME'), scheme_id: z.string() }),
      z.strictObject({ type: z.literal('TERMINAL_STATE'), terminal_code: z.string() }),
      z.null(),
    ]),
    options: z
      .array(
        z.strictObject({
          drug_id: z.number().int().positive(),
          action: z.enum(['ALLOW', 'WARN', 'BLOCK', 'REVIEW_REQUIRED']).optional(),
          drug_name: z.string().optional(),
          dose_status: z.string().optional(),
          regimen: z.record(z.string(), z.unknown()).optional(),
        }),
      )
      .optional(),
  }),
});
export function validateFacts(
  content: ClinicalContent,
  facts: Record<string, FactValue>,
  medications?: Medications,
) {
  for (const [key, f] of Object.entries(facts)) {
    const raw = content.rules.fact_definitions.find((x) => x.fact_code === key);
    if (!raw) fail(400, 'INPUT_VALIDATION_ERROR', `Неизвестный факт: ${key}`);
    const def = formDefinition(raw);
    if (f.unit !== undefined && f.unit !== null && f.unit !== (def.unit ?? null))
      fail(400, 'INPUT_VALIDATION_ERROR', `Неверная единица: ${key}`);
    if (f.state !== 'KNOWN') continue;
    const v = f.value;
    if (
      (def.data_type === 'BOOLEAN' && typeof v !== 'boolean') ||
      (['INTEGER', 'DECIMAL'].includes(def.data_type) && typeof v !== 'number') ||
      (['STRING', 'ENUM', 'DATE'].includes(def.data_type) && typeof v !== 'string')
    )
      fail(400, 'INPUT_VALIDATION_ERROR', `Неверный тип: ${key}`);
    if (
      typeof v === 'number' &&
      ((def.data_type === 'INTEGER' && !Number.isInteger(v)) ||
        (def.min_value != null && v < def.min_value) ||
        (def.max_value != null && v > def.max_value))
    )
      fail(400, 'INPUT_VALIDATION_ERROR', `Значение вне диапазона: ${key}`);
    if (def.data_type === 'ENUM' && !def.enum_values?.includes(String(v)))
      fail(400, 'INPUT_VALIDATION_ERROR', `Неизвестное значение: ${key}`);
    if (def.data_type === 'DATE' && !/^\d{4}-\d{2}-\d{2}$/.test(String(v)))
      fail(400, 'INPUT_VALIDATION_ERROR', `Неверная дата: ${key}`);
  }
  if (medications?.drug_ids.some((drug) => !content.drugs.some((x) => x.drug_id === drug)))
    fail(400, 'INPUT_VALIDATION_ERROR', 'Неизвестный drug_id');
}
export function snapshot(draft: CaseDraft): CaseDraft {
  return {
    id: draft.id,
    nosology_code: draft.nosology_code,
    facts: structuredClone(draft.facts),
    medications: structuredClone(draft.medications),
    created_at: draft.created_at,
    updated_at: draft.updated_at,
  };
}
