import type {
  Action,
  CaseDraft,
  ClinicalContent,
  DoseRule,
  Regimen,
  SafetyRule,
  TherapyOption,
} from '../../contracts/src/index.ts';
import { evaluateExpression } from '../../clinical/src/expression.ts';

const NUMBER = String.raw`\d+(?:[.,]\d+)?`;
const UNIT = String.raw`(?:млн\s*МЕ|мкг|мг|мл|МЕ|г)(?![а-яёa-z])`;
const amount = (text: string) => Number(text.replace(',', '.'));
const unit = (text: string) =>
  /млн/i.test(text) ? 'млн МЕ' : /^ме$/i.test(text) ? 'МЕ' : text.toLowerCase();
const emptyRegimen = (text: string): Regimen => ({
  dose_amount: null,
  dose_unit: null,
  route: null,
  frequency_per_day: null,
  duration_days: null,
  source_text: text,
  parse_status: 'REVIEW_REQUIRED',
});

/** Только синтаксический перенос исходных данных; недостающие назначения не дополняются. */
export function parseRegimen(text: string): Regimen {
  const result = emptyRegimen(text);
  // Compiler заранее разделяет варианты разных препаратов. Число после «или»
  // означает альтернативную дозировку того же препарата, а не выбранную дозу.
  const variants = text.split(/\s+или\s+(?=\d)/iu);
  if (variants.length > 1) {
    result.variants = variants.map(parseRegimen);
    result.parse_status = result.variants.every((v) => v.parse_status === 'STRUCTURED')
      ? 'STRUCTURED'
      : 'REVIEW_REQUIRED';
    return result;
  }
  const normalized = text.replace(/\s+/gu, ' ').trim();
  // Не интерпретируем строку сразу нескольких препаратов как один режим.
  if (/\sили\s/iu.test(normalized)) return result;
  let maintenance = normalized;
  const loading = normalized.match(
    new RegExp(`(${NUMBER})\\s*(${UNIT})\\s+в\\s+первый\\s+день(.*?)далее\\s+`, 'iu'),
  );
  if (loading) {
    result.loading_dose = { dose_amount: amount(loading[1]), dose_unit: unit(loading[2]), duration_days: 1 };
    const loadingFrequency = loading[3].match(/(\d+)\s+раз(?:а)?\s+в\s+сутки/iu);
    const loadingAdministration = loading[3].match(new RegExp(`по\\s+(${NUMBER})\\s*(${UNIT})`, 'iu'));
    if (loadingFrequency) result.loading_dose.frequency_per_day = Number(loadingFrequency[1]);
    if (loadingAdministration && unit(loadingAdministration[2]) === result.loading_dose.dose_unit) {
      result.loading_dose.dose_per_administration = amount(loadingAdministration[1]);
    }
    maintenance = normalized.slice((loading.index ?? 0) + loading[0].length);
  }

  const route = normalized.match(/внутримышечно|внутривенно|внутрь|в\/м|в\/в/iu)?.[0].toLowerCase();
  result.route = route === 'в/м' ? 'внутримышечно' : route === 'в/в' ? 'внутривенно' : (route ?? null);
  const frequencies = [
    ...maintenance.matchAll(
      new RegExp(`(${NUMBER})\\s+раз(?:а)?\\s+в\\s+(?:сутки|сут|день)(?![а-я])`, 'giu'),
    ),
  ];
  const interval = maintenance.match(new RegExp(`каждые\\s+(${NUMBER})\\s+час`, 'iu'));
  const dividedDaily = maintenance.match(/в\s+сутки\s+в\s+(\d+)\s+при[её]ма?/iu);
  if (frequencies.length === 1) result.frequency_per_day = amount(frequencies[0][1]);
  else if (interval && amount(interval[1]) > 0) result.frequency_per_day = 24 / amount(interval[1]);
  else if (dividedDaily) result.frequency_per_day = Number(dividedDaily[1]);

  const duration = maintenance.match(/(\d+)\s*(?:[-–—]\s*(\d+))?\s*(?:дней|дня|день)(?![а-я])/iu);
  if (duration) {
    result.duration_days = Number(duration[1]);
    if (duration[2]) result.duration_max_days = Number(duration[2]);
  }
  // «таблеткb» — исходная техническая опечатка окончания слова; исходник не меняется.
  const tablets = maintenance.match(
    new RegExp(`по\\s+(${NUMBER})\\s+таблет(?:к[а-яёb]*|ок)(?![а-яёa-z])`, 'iu'),
  );
  const tabletCount = tablets ? amount(tablets[1]) : 1;
  const slashCombination = maintenance.match(
    new RegExp(`(${NUMBER})\\s*/\\s*(${NUMBER})\\s*(${UNIT})`, 'iu'),
  );
  const plusCombination = maintenance.match(
    new RegExp(`${NUMBER}\\s*${UNIT}(?:\\s*\\+\\s*${NUMBER}\\s*${UNIT})+`, 'iu'),
  );
  if (slashCombination) {
    result.components = [1, 2].map((index) => ({
      amount: amount(slashCombination[index]) * tabletCount,
      unit: unit(slashCombination[3]),
    }));
    result.dose_unit = unit(slashCombination[3]);
  } else if (plusCombination) {
    result.components = [...plusCombination[0].matchAll(new RegExp(`(${NUMBER})\\s*(${UNIT})`, 'giu'))].map(
      (component) => ({ amount: amount(component[1]) * tabletCount, unit: unit(component[2]) }),
    );
    result.dose_unit = result.components.every((component) => component.unit === result.components?.[0].unit)
      ? result.components[0].unit
      : null;
  } else {
    const doses = [
      ...maintenance.matchAll(
        new RegExp(`(${NUMBER})\\s*(?:[-–—]\\s*(${NUMBER}))?\\s*(${UNIT})(\\s*/\\s*сут)?`, 'giu'),
      ),
    ];
    if (doses.length === 1) {
      const dose = doses[0];
      result.dose_unit = unit(dose[3]) + (dose[4] ? '/сут' : '');
      // Диапазон рядом с числом таблеток допускает разные прочтения силы/дозы.
      const unsupportedDivisor =
        !dose[4] && /^\s*\//u.test(maintenance.slice((dose.index ?? 0) + dose[0].length));
      if (!(dose[2] && tablets) && !unsupportedDivisor) {
        result.dose_amount = amount(dose[1]) * tabletCount;
        if (dose[2]) result.dose_max = amount(dose[2]);
        if (dividedDaily && result.frequency_per_day && !dose[4]) {
          result.dose_amount /= result.frequency_per_day;
          if (result.dose_max != null) result.dose_max /= result.frequency_per_day;
        } else if (
          /^\s+в\s+сутки/iu.test(maintenance.slice((dose.index ?? 0) + dose[0].length)) &&
          !dividedDaily
        ) {
          result.dose_unit += '/сут';
        }
      }
    }
  }
  const hasDose = result.dose_amount !== null || Boolean(result.components?.length);
  const positive = (value: number | null) => value !== null && Number.isFinite(value) && value > 0;
  const validAmounts = result.components
    ? result.components.every((c) => positive(c.amount))
    : positive(result.dose_amount);
  const validRanges =
    (result.dose_max == null || (result.dose_amount !== null && result.dose_max >= result.dose_amount)) &&
    (result.duration_max_days == null ||
      (result.duration_days !== null && result.duration_max_days >= result.duration_days));
  const loadingConsistent =
    !result.loading_dose ||
    !result.loading_dose.frequency_per_day ||
    !result.loading_dose.dose_per_administration ||
    result.loading_dose.frequency_per_day * result.loading_dose.dose_per_administration ===
      result.loading_dose.dose_amount;
  if (
    hasDose &&
    validAmounts &&
    validRanges &&
    loadingConsistent &&
    result.route &&
    positive(result.frequency_per_day) &&
    positive(result.duration_days) &&
    !result.dose_unit?.endsWith('/сут')
  ) {
    result.parse_status = 'STRUCTURED';
  }
  return result;
}

const ACTION_PRIORITY: Record<Action, number> = { ALLOW: 0, WARN: 1, REVIEW_REQUIRED: 2, BLOCK: 3 };
const active = (rule: { enabled: boolean; validation_status: string }) =>
  rule.enabled === true && rule.validation_status === 'VALIDATED';
const inScope = (rule: SafetyRule, draft: CaseDraft) =>
  !rule.nosology_code || rule.nosology_code === 'ALL' || rule.nosology_code === draft.nosology_code;
type TherapyResult = {
  options: TherapyOption[];
  warnings: string[];
  safety_status: string;
  trace: unknown[];
};

function resolveDose(
  content: ClinicalContent,
  draft: CaseDraft,
  option: TherapyOption,
  trace: unknown[],
  warnings: Set<string>,
): void {
  const candidates = content.dose_rules.filter(
    (rule) => active(rule) && rule.nosology_code === draft.nosology_code && rule.drug_id === option.drug_id,
  );
  const matched: DoseRule[] = [];
  const missingFacts = new Set<string>();
  let unresolved = false;
  for (const rule of candidates) {
    const requiredMissing = rule.required_facts.filter((code) => {
      const fact = draft.facts[code];
      return !fact || fact.state !== 'KNOWN' || fact.value === null;
    });
    const evaluation = evaluateExpression(rule.condition, draft.facts);
    const missing = [...new Set([...requiredMissing, ...evaluation.missing])];
    const result =
      evaluation.value === false ? 'FALSE' : missing.length || evaluation.value !== true ? 'UNKNOWN' : 'TRUE';
    trace.push({
      stage: 'DOSE',
      option_id: option.option_id,
      rule_id: rule.rule_id,
      result,
      missing_facts: missing,
      source: rule.source,
    });
    if (result === 'UNKNOWN') {
      unresolved = true;
      missing.forEach((code) => missingFacts.add(code));
    } else if (result === 'TRUE') matched.push(rule);
  }
  if (unresolved) {
    option.dose_status = 'BASE_REGIMEN_MISSING_DATA';
    warnings.add('Недостаточно данных для корректировки дозы; сохранён базовый режим.');
  } else if (matched.length > 1) {
    option.dose_status = 'BASE_REGIMEN_CONFLICT';
    option.findings.push({
      action: 'REVIEW_REQUIRED',
      message:
        'Одновременно выполнено несколько правил дозирования; сохранён базовый режим для ручной проверки.',
    });
  } else if (matched.length === 1) {
    option.regimen = structuredClone(matched[0].regimen);
    option.dose_status = 'ADJUSTED';
    trace.push({
      stage: 'DOSE',
      option_id: option.option_id,
      action: 'APPLY_VALIDATED_RULE',
      rule_id: matched[0].rule_id,
      source: matched[0].source,
      regimen: structuredClone(option.regimen),
    });
    return;
  }
  trace.push({
    stage: 'DOSE',
    option_id: option.option_id,
    action: 'USE_BASE_REGIMEN',
    reason: option.dose_status,
    missing_facts: [...missingFacts],
    candidate_rule_ids: candidates.map((rule) => rule.rule_id),
  });
}

function checkSafetyRule(
  rule: SafetyRule,
  stage: 'CONTRAINDICATION' | 'INTERACTION',
  draft: CaseDraft,
): { result: 'TRUE' | 'FALSE' | 'UNKNOWN'; missing: string[] } {
  const evaluation = rule.condition
    ? evaluateExpression(rule.condition, draft.facts)
    : { value: stage === 'INTERACTION' && rule.concomitant_drug_id !== undefined ? true : null, missing: [] };
  if (evaluation.value === false) return { result: 'FALSE', missing: [] };
  if (stage === 'INTERACTION') {
    if (rule.concomitant_drug_id === undefined)
      return { result: 'UNKNOWN', missing: ['concomitant_drug_id'] };
    if (!draft.medications.drug_ids.includes(rule.concomitant_drug_id)) {
      if (draft.medications.state === 'UNKNOWN' || draft.medications.unrecognized.length)
        return { result: 'UNKNOWN', missing: ['medications', ...evaluation.missing] };
      return { result: 'FALSE', missing: [] };
    }
  }
  return { result: evaluation.value === true ? 'TRUE' : 'UNKNOWN', missing: evaluation.missing };
}

/** Независимые стадии therapy → safety → dosing, без новых медицинских правил. */
export function resolveTherapy(content: ClinicalContent, schemeId: string, draft: CaseDraft): TherapyResult {
  const trace: unknown[] = [];
  const warnings = new Set<string>();
  const scheme = content.rules.schemes.find(
    (item) => item.scheme_id === schemeId && item.nosology_code === draft.nosology_code,
  );
  if (!scheme)
    return {
      options: [],
      warnings: ['Схема отсутствует или не соответствует нозологии случая.'],
      safety_status: 'INCOMPLETE',
      trace: [{ stage: 'THERAPY', scheme_id: schemeId, status: 'SCHEME_NOT_FOUND_OR_SCOPE_MISMATCH' }],
    };

  const contraindications = content.contraindications.filter((rule) => active(rule) && inScope(rule, draft));
  const interactions = content.interactions.filter((rule) => active(rule) && inScope(rule, draft));
  let incomplete = contraindications.length === 0 || interactions.length === 0;
  if (!contraindications.length)
    warnings.add('Валидированный справочник противопоказаний недоступен; проверка выполнена не полностью.');
  if (!interactions.length)
    warnings.add('Валидированный справочник взаимодействий недоступен; проверка выполнена не полностью.');
  const medicationsIncomplete =
    draft.medications.state === 'UNKNOWN' || draft.medications.unrecognized.length > 0;
  if (medicationsIncomplete) {
    incomplete = true;
    warnings.add(
      'Список сопутствующих препаратов неизвестен или содержит нераспознанные позиции; проверка взаимодействий неполная.',
    );
  }
  trace.push({
    stage: 'SAFETY_AVAILABILITY',
    contraindications_available: contraindications.length > 0,
    interactions_available: interactions.length > 0,
    medications_state: draft.medications.state,
    medications_incomplete: medicationsIncomplete,
  });

  const options = content.rules.treatment_options
    .filter((item) => item.scheme_id === schemeId)
    .map((treatment) => {
      const drug = content.drugs.find((item) => item.drug_id === treatment.drug_id);
      const option: TherapyOption = {
        option_id: treatment.treatment_option_id,
        drug_id: treatment.drug_id,
        drug_name: drug?.generic_name_ru ?? `Неизвестный препарат ${treatment.drug_id}`,
        line: treatment.line_type,
        source_text: treatment.base_regimen_text,
        regimen: parseRegimen(treatment.base_regimen_text),
        eligibility: 'ELIGIBLE',
        action: 'ALLOW',
        findings: [],
        dose_status: 'BASE_REGIMEN',
      };
      trace.push({
        stage: 'THERAPY',
        scheme_id: schemeId,
        option_id: option.option_id,
        drug_id: option.drug_id,
        source: treatment.source,
        source_text: treatment.base_regimen_text,
      });
      if (!drug || drug.active === false)
        option.findings.push({
          action: 'REVIEW_REQUIRED',
          message: 'Препарат отсутствует в активном реестре; требуется проверка медицинского контента.',
        });

      const groups = [
        { stage: 'CONTRAINDICATION' as const, rules: contraindications },
        { stage: 'INTERACTION' as const, rules: interactions },
      ];
      for (const { stage, rules } of groups)
        for (const rule of rules.filter((item) => item.drug_id === option.drug_id)) {
          const evaluation = checkSafetyRule(rule, stage, draft);
          trace.push({
            stage,
            option_id: option.option_id,
            rule_id: rule.rule_id,
            result: evaluation.result,
            missing_facts: evaluation.missing,
            source: rule.source,
          });
          if (evaluation.result === 'TRUE')
            option.findings.push({
              action: rule.action,
              message: rule.message,
              source: rule.source,
              rule_id: rule.rule_id,
            });
          else if (evaluation.result === 'UNKNOWN') {
            incomplete = true;
            option.findings.push({
              action: 'REVIEW_REQUIRED',
              message: `Условие правила ${rule.rule_id} не определено; требуется ручная проверка.`,
              source: rule.source,
              rule_id: rule.rule_id,
            });
            warnings.add('Часть условий безопасности не определена; проверка выполнена не полностью.');
          }
        }
      if (medicationsIncomplete)
        option.findings.push({
          action: 'REVIEW_REQUIRED',
          message: 'Неполный список сопутствующих препаратов; требуется проверка взаимодействий.',
        });
      resolveDose(content, draft, option, trace, warnings);
      if (option.regimen.parse_status === 'REVIEW_REQUIRED')
        option.findings.push({
          action: 'REVIEW_REQUIRED',
          message:
            'Исходный режим содержит неполные или неоднозначные данные; требуется сверка с источником.',
        });
      option.action = option.findings.reduce<Action>(
        (action, finding) =>
          ACTION_PRIORITY[finding.action] > ACTION_PRIORITY[action] ? finding.action : action,
        'ALLOW',
      );
      option.eligibility =
        option.action === 'BLOCK'
          ? 'BLOCKED'
          : option.action === 'REVIEW_REQUIRED'
            ? 'REVIEW_REQUIRED'
            : 'ELIGIBLE';
      trace.push({
        stage: 'THERAPY_RESULT',
        option_id: option.option_id,
        action: option.action,
        eligibility: option.eligibility,
        dose_status: option.dose_status,
      });
      return option;
    });
  if (!options.length) {
    incomplete = true;
    warnings.add('Для выбранной схемы отсутствуют варианты терапии.');
  }
  return { options, warnings: [...warnings], safety_status: incomplete ? 'INCOMPLETE' : 'COMPLETE', trace };
}
