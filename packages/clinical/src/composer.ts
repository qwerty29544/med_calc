import type { Regimen, TherapyOption } from '../../contracts/src';
export function regimenText(r: Regimen): string {
  if (r.variants?.length) return r.variants.map(regimenText).join(' или ');
  const dose = r.components?.length
    ? r.components.map((c) => `${c.amount} ${c.unit}`).join(' + ')
    : r.dose_amount !== null
      ? `${r.dose_amount}${r.dose_max != null ? `–${r.dose_max}` : ''} ${r.dose_unit ?? ''}`
      : 'доза требует уточнения';
  const parts = [
    dose,
    r.route ?? 'путь введения не указан',
    r.frequency_per_day !== null ? `${r.frequency_per_day} раза в сутки` : 'частота не указана',
    r.duration_days !== null
      ? `${r.duration_days}${r.duration_max_days != null ? `–${r.duration_max_days}` : ''} дней`
      : 'длительность не указана',
  ];
  if (r.loading_dose)
    parts.unshift(
      `Нагрузочная доза: ${r.loading_dose.dose_amount} ${r.loading_dose.dose_unit} за ${r.loading_dose.duration_days} день${r.loading_dose.frequency_per_day ? `, в ${r.loading_dose.frequency_per_day} приема` : ''}; далее`,
    );
  return parts.join(', ');
}
export function optionText(o: TherapyOption): string {
  return `${o.dose_status === 'ADJUSTED' ? `${o.drug_name}: ${regimenText(o.regimen)} [скорректированный режим]` : o.source_text}${o.eligibility === 'REVIEW_REQUIRED' ? ' [Требуется оценка врача; не автоматическое назначение]' : ''}${o.regimen.parse_status === 'REVIEW_REQUIRED' ? ' [Режим требует проверки по источнику]' : ''}`;
}
