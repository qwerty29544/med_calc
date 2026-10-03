import { createHash } from 'node:crypto';
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export function hashContent(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
export function hashRules(value: unknown): string {
  const { ruleset_hash: _, ...rest } = value as Record<string, unknown>;
  return hashContent(rest);
}
