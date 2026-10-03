import registry from '../../../content/source/01_drug_registry_v0.1.0.json';
const normalize = (s: string) => s.toLocaleLowerCase('ru').replaceAll('ё', 'е').replace(/\s+/gu, '');
const entries = registry.Drugs.slice(1)
  .map((r) => ({ id: Number(r[0]), name: String(r[1]) }))
  .sort((a, b) => b.name.length - a.name.length);
/** Точное название МНН в начале режима; более длинная комбинация имеет приоритет. */
export function drugIdFromSourceText(text: string): number | undefined {
  return entries.find((d) => normalize(text).startsWith(normalize(d.name)))?.id;
}
