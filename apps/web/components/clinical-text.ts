import type { FactValue } from '../../../packages/contracts/src/index';

// Copy-editing only: clinical packages, rules and stored snapshots remain unchanged.
export function clinicalText(text: string) {
  return text
    .replaceAll('2 разf', '2 раза')
    .replaceAll('высоко вероятна', 'высоковероятна')
    .replaceAll('этиология ОТФ', 'этиология острого тонзиллофарингита');
}
export function enumLabel(value: string) {
  return (
    ({ GOLD_I_II: 'GOLD I–II', GOLD_III: 'GOLD III', GOLD_IV: 'GOLD IV' } as Record<string, string>)[value] ||
    value
  );
}
export function displayUnit(unit: string) {
  return ({ years: 'лет', year: 'лет', days: 'дней', day: 'дней' } as Record<string, string>)[unit] || unit;
}
export function factText(value: FactValue) {
  return value.state === 'UNKNOWN'
    ? 'Неизвестно'
    : value.state === 'NOT_ASSESSED'
      ? 'Не оценивалось'
      : typeof value.value === 'boolean'
        ? value.value
          ? 'Да'
          : 'Нет'
        : `${typeof value.value === 'string' ? enumLabel(value.value) : (value.value ?? '—')}${value.unit ? ` ${displayUnit(value.unit)}` : ''}`;
}
