'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronRight,
  Clipboard,
  Download,
  FileText,
  History,
  Info,
  MessageSquare,
  Pill,
  Search,
  ShieldAlert,
  ShieldCheck,
  ThumbsDown,
  ThumbsUp,
} from 'lucide-react';
import type { EvaluationView, Regimen, TherapyOption } from '../../../packages/contracts/src/index';
import { api, dateText, errorText, post, type Catalog, type User } from './api';
import { Badge, Empty, ErrorNotice, Loading, PageTitle, Success } from './ui';
import { factText } from './case-editor';

const statusLabels: Record<string, string> = {
  COMPLETED: 'Расчёт завершён',
  NEEDS_INPUT: 'Нужны данные',
  FAILED: 'Ошибка расчёта',
};
const safetyLabels: Record<string, string> = {
  COMPLETE: 'Проверка выполнена',
  COMPLETED: 'Проверка выполнена',
  INCOMPLETE: 'Проверка безопасности неполная',
  NOT_APPLICABLE: 'Проверка не требуется',
  REVIEW_REQUIRED: 'Требуется оценка врача',
  NOT_ASSESSED: 'Безопасность не оценивалась',
};
const lineLabels: Record<string, string> = {
  FIRST_LINE: 'Первая линия',
  FIRST: 'Первая линия',
  PRIMARY: 'Первая линия',
  ALTERNATIVE: 'Альтернатива',
  ALTERNATIVE_1: 'Альтернатива 1',
  ALTERNATIVE_2: 'Альтернатива 2',
  ALTERNATIVE_3: 'Альтернатива 3',
  SECOND_LINE: 'Вторая линия',
  RESERVE: 'Резерв',
};
const doseLabels: Record<string, string> = {
  BASE: 'Базовый режим',
  BASE_REGIMEN: 'Базовый режим',
  USE_BASE_REGIMEN: 'Базовый режим',
  ADJUSTED: 'Режим скорректирован',
  REVIEW_REQUIRED: 'Режим требует проверки',
  BASE_FALLBACK: 'Базовый режим: недостаточно данных для коррекции',
  BASE_REGIMEN_MISSING_DATA: 'Базовый режим: недостаточно данных для коррекции',
  BASE_REGIMEN_CONFLICT: 'Базовый режим: конфликт правил, требуется проверка',
};
const eligibilityLabels: Record<string, string> = {
  ELIGIBLE: 'Допустимый вариант',
  BLOCKED: 'Исключён',
  REVIEW_REQUIRED: 'Оценка врача',
};
export function ResultContent({
  evaluation: result,
  compact = false,
  user,
}: {
  evaluation: EvaluationView;
  compact?: boolean;
  user: User;
}) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState('');
  async function copy() {
    try {
      await navigator.clipboard.writeText(result.copy_text);
      setCopied(true);
      setCopyError('');
    } catch {
      setCopyError(
        'Автоматическое копирование недоступно. Выделите текст в разделе «Текст рекомендации» и скопируйте его.',
      );
    }
  }
  const completeSafety = ['COMPLETE', 'COMPLETED', 'NOT_APPLICABLE'].includes(result.safety_status);
  const technicalRole = user.role !== 'DOCTOR';
  return (
    <div className="result-content">
      <section className={`result-summary ${result.status === 'FAILED' ? 'failed' : ''}`}>
        <div className="result-heading">
          <span className="result-icon">
            {result.status === 'COMPLETED' ? <CheckCircle2 size={25} /> : <Info size={25} />}
          </span>
          <div>
            <div className="eyebrow">
              {compact ? 'ПРЕДВАРИТЕЛЬНЫЙ РЕЗУЛЬТАТ' : 'ИТОГ КЛИНИЧЕСКОГО РАСЧЁТА'}
            </div>
            <h2>{result.title}</h2>
          </div>
          <Badge tone={result.status === 'COMPLETED' ? 'success' : 'warning'}>
            {statusLabels[result.status] || result.status}
          </Badge>
        </div>
        {result.demo && (
          <p className="result-demo">
            <ShieldAlert size={16} />
            Демонстрационный результат. Медицинский контент не утверждён для клинических назначений.
          </p>
        )}
        <div className={`safety-line ${completeSafety ? 'complete' : 'incomplete'}`}>
          {completeSafety ? <ShieldCheck size={18} /> : <ShieldAlert size={18} />}
          <strong>{safetyLabels[result.safety_status] || 'Требуется проверка безопасности'}</strong>
          {!completeSafety && <span>Не означает отсутствие противопоказаний и взаимодействий.</span>}
        </div>
      </section>
      {result.warnings.length > 0 && (
        <section className="notice warning result-warnings">
          <ShieldAlert size={21} />
          <div>
            <h3>На что обратить внимание</h3>
            <ul>
              {result.warnings.map((warning, i) => (
                <li key={i}>{warning}</li>
              ))}
            </ul>
          </div>
        </section>
      )}
      {result.errors?.map((e, i) => (
        <ErrorNotice key={i} message={e.message} />
      ))}
      {result.options.length > 0 && (
        <section>
          <div className="section-heading">
            <h2>Варианты терапии</h2>
            <span>{result.options.length} в текущей схеме</span>
          </div>
          <div className="therapy-list">
            {result.options.map((option) => (
              <TherapyCard key={option.option_id} option={option} />
            ))}
          </div>
        </section>
      )}
      <section className="panel explanation-panel">
        <div className="section-title-icon">
          <span>
            <ListIcon />
          </span>
          <div>
            <h2>Почему получен этот результат</h2>
            <p>Объяснение на основе введённых данных и правил</p>
          </div>
        </div>
        {result.explanation.length ? (
          <ol className="explanation-list">
            {result.explanation.map((step, index) => (
              <li key={index}>
                <span>{index + 1}</span>
                <p>{step}</p>
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted">Сервер не предоставил текстовое объяснение.</p>
        )}
      </section>
      {!compact && (
        <>
          <section className="panel copy-panel">
            <div className="panel-heading">
              <div>
                <h2>Текст рекомендации</h2>
                <p>Структурированный текст для копирования</p>
              </div>
              <button className="button secondary small" onClick={copy}>
                {copied ? <Check size={15} /> : <Clipboard size={15} />}
                {copied ? 'Скопировано' : 'Копировать'}
              </button>
            </div>
            {copyError && <ErrorNotice message={copyError} />}
            <pre className="recommendation-text" tabIndex={0}>
              {result.copy_text}
            </pre>
          </section>
          <details className="panel details-panel">
            <summary>
              <FileText size={18} />
              <span>Версии и контрольные суммы</span>
              <ChevronRight size={17} />
            </summary>
            <div className="details-body">
              <p className="muted">
                Результат связан с конкретными версиями контента и не меняется при обновлении правил.
              </p>
              <div className="version-list">
                {Object.entries(result.versions).map(([key, version]) => (
                  <div key={key}>
                    <strong>{componentLabel(key)}</strong>
                    <code>{version}</code>
                    {result.hashes[key] && <code className="hash">SHA-256 {result.hashes[key]}</code>}
                  </div>
                ))}
              </div>
              {Object.entries(result.hashes)
                .filter(([key]) => !Object.hasOwn(result.versions, key))
                .map(([key, hash]) => (
                  <div className="extra-hash" key={key}>
                    <strong>{componentLabel(key)}</strong>
                    <code className="hash">SHA-256 {hash}</code>
                  </div>
                ))}
              {result.outcome && (
                <p className="technical-code">
                  {result.outcome.type === 'TREATMENT_SCHEME'
                    ? `Схема: ${result.outcome.scheme_id}`
                    : `Конечное состояние: ${result.outcome.terminal_code}`}
                </p>
              )}
            </div>
          </details>
          {technicalRole && (
            <details className="panel details-panel">
              <summary>
                <History size={18} />
                <span>Техническая трассировка решения</span>
                <ChevronRight size={17} />
              </summary>
              <div className="details-body">
                <p className="muted">Последовательность выполнения, зафиксированная сервером.</p>
                <pre className="json-view">{JSON.stringify(result.trace, null, 2)}</pre>
              </div>
            </details>
          )}
        </>
      )}
    </div>
  );
}
function ListIcon() {
  return <FileText size={21} />;
}
function componentLabel(key: string) {
  return (
    (
      {
        ruleset: 'Клинические правила',
        clinical_rules: 'Клинические правила',
        drug_registry: 'Справочник препаратов',
        contraindications: 'Противопоказания',
        interactions: 'Взаимодействия',
        drug_interactions: 'Взаимодействия',
        dose_rules: 'Правила дозирования',
        dosing: 'Правила дозирования',
        questions: 'Формы вопросов',
      } as Record<string, string>
    )[key] || key
  );
}
function TherapyCard({ option }: { option: TherapyOption }) {
  const blocked = option.eligibility === 'BLOCKED' || option.action === 'BLOCK';
  const review = option.eligibility === 'REVIEW_REQUIRED' || option.action === 'REVIEW_REQUIRED';
  return (
    <article className={`therapy-card ${blocked ? 'blocked' : ''}`}>
      <div className="therapy-title">
        <span className="drug-icon">
          <Pill size={22} />
        </span>
        <div>
          <span className="therapy-line">{lineLabels[option.line] || option.line}</span>
          <h3>{option.drug_name}</h3>
        </div>
        <Badge
          tone={blocked ? 'danger' : review ? 'warning' : option.action === 'WARN' ? 'warning' : 'success'}
        >
          {blocked ? 'Исключён' : eligibilityLabels[option.eligibility] || option.eligibility}
        </Badge>
      </div>
      {option.dose_status !== 'ADJUSTED' && <p className="regimen-source">{option.source_text}</p>}
      {option.dose_status === 'ADJUSTED' && (
        <p className="regimen-caption">Итоговый скорректированный режим</p>
      )}
      {option.regimen && <RegimenDetails regimen={option.regimen} />}
      <div className="dose-note">
        <Info size={14} />
        {doseLabels[option.dose_status] || option.dose_status}
      </div>
      {option.dose_status === 'ADJUSTED' && (
        <details className="source-regimen">
          <summary>Исходная схема из источника · для сравнения</summary>
          <p className="regimen-source">{option.source_text}</p>
        </details>
      )}
      {option.findings.length > 0 && (
        <ul className="finding-list">
          {option.findings.map((finding, i) => (
            <li key={i} className={finding.action === 'BLOCK' ? 'blocked-finding' : ''}>
              <ShieldAlert size={15} />
              <div>
                <span>{finding.message}</span>
                {finding.source && <small>Источник: {finding.source}</small>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
function RegimenDetails({ regimen }: { regimen: Regimen }) {
  return (
    <>
      <div className="regimen-grid">
        {regimen.dose_amount !== null && (
          <div>
            <span>Доза</span>
            <strong>
              {regimen.dose_amount}
              {regimen.dose_max ? `–${regimen.dose_max}` : ''} {regimen.dose_unit}
            </strong>
          </div>
        )}
        {regimen.frequency_per_day !== null && (
          <div>
            <span>Кратность</span>
            <strong>{regimen.frequency_per_day} в сутки</strong>
          </div>
        )}
        {regimen.duration_days !== null && (
          <div>
            <span>Длительность</span>
            <strong>
              {regimen.duration_days}
              {regimen.duration_max_days ? `–${regimen.duration_max_days}` : ''} дней
            </strong>
          </div>
        )}
        {regimen.route && (
          <div>
            <span>Введение</span>
            <strong>{regimen.route}</strong>
          </div>
        )}
        {regimen.components && regimen.components.length > 0 && (
          <div>
            <span>Компоненты дозы</span>
            <strong>{regimen.components.map((c) => `${c.amount} ${c.unit}`).join(' + ')}</strong>
          </div>
        )}
      </div>
      {regimen.loading_dose && (
        <div className="regimen-grid loading-regimen">
          <div>
            <span>Нагрузочная доза</span>
            <strong>
              {regimen.loading_dose.dose_amount} {regimen.loading_dose.dose_unit}
            </strong>
          </div>
          <div>
            <span>Длительность нагрузочного режима</span>
            <strong>{regimen.loading_dose.duration_days} дней</strong>
          </div>
        </div>
      )}
      {regimen.parse_status === 'REVIEW_REQUIRED' && (
        <p className="medication-warning">
          <ShieldAlert size={15} />
          Режим требует ручной проверки по источнику.
        </p>
      )}
      {regimen.variants?.map((variant, index) => (
        <div className="regimen-variant" key={index}>
          <h4>Вариант режима {index + 1}</h4>
          <RegimenDetails regimen={variant} />
        </div>
      ))}
    </>
  );
}
export function SavedResult({ id, catalog, user }: { id: string; catalog?: Catalog; user: User }) {
  const result = useQuery({
    queryKey: ['evaluation', id],
    queryFn: () => api<EvaluationView>(`/evaluations/${id}`),
  });
  if (result.isPending) return <Loading text="Загружаем сохранённый результат…" />;
  if (result.error || !result.data)
    return <ErrorNotice message={errorText(result.error)} retry={() => void result.refetch()} />;
  const data = result.data;
  const snapshot = data.snapshot;
  return (
    <>
      <Link href="/app/history" className="back-link">
        <ArrowLeft size={15} />
        История расчётов
      </Link>
      <PageTitle
        eyebrow="РЕЗУЛЬТАТ"
        title="Сохранённый результат"
        description={`${dateText(data.created_at)} · ${catalog?.nosologies.find((n) => n.nosology_code === (data.nosology_code || snapshot?.nosology_code))?.name_ru || 'Клинический случай'}`}
        action={
          <Link className="button secondary" href="/app/new">
            Новый расчёт
            <ArrowRight size={16} />
          </Link>
        }
      />
      <div className="immutable-note">
        <ShieldCheck size={16} />
        Этот результат сохранён как неизменяемый снимок данных и версий правил.
      </div>
      <div className="result-layout">
        <div>
          <ResultContent evaluation={data} user={user} />
          {snapshot && (
            <details className="panel details-panel">
              <summary>
                <FileText size={18} />
                <span>Входные данные на момент расчёта</span>
                <ChevronRight size={17} />
              </summary>
              <div className="details-body">
                <dl className="snapshot-list">
                  {Object.entries(snapshot.facts).map(([code, value]) => (
                    <div key={code}>
                      <dt>{catalog?.facts.find((f) => f.fact_code === code)?.label_ru || code}</dt>
                      <dd>{factText(value)}</dd>
                    </div>
                  ))}
                </dl>
                <p className="muted">
                  Сопутствующая терапия:{' '}
                  {snapshot.medications.state === 'UNKNOWN'
                    ? 'неизвестна'
                    : snapshot.medications.state === 'KNOWN_NONE'
                      ? 'не принимает'
                      : `${snapshot.medications.drug_ids.length} препаратов из справочника, ${snapshot.medications.unrecognized.length} нераспознанных`}
                </p>
              </div>
            </details>
          )}
        </div>
        <aside>
          <Feedback id={id} />
          <div className="context-help">
            <h3>Решение остаётся за врачом</h3>
            <p>
              Оцените применимость результата к клиническому случаю. Система не заменяет профессиональную
              оценку.
            </p>
            <Link href={`/app/cases/${data.case_id}`} className="text-link">
              Открыть исходный случай
              <ArrowRight size={14} />
            </Link>
            <p className="small-text">Изменения исходного случая не изменят этот результат.</p>
          </div>
        </aside>
      </div>
    </>
  );
}
function Feedback({ id }: { id: string }) {
  const [agreement, setAgreement] = useState<'AGREE' | 'DISAGREE' | null>(null);
  const [used, setUsed] = useState(false);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');
  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!agreement) return;
    setBusy(true);
    setError('');
    try {
      await post(`/evaluations/${id}/feedback`, { agreement, used, comment });
      setSuccess(true);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel feedback-panel">
      <span className="feedback-icon">
        <MessageSquare size={23} />
      </span>
      <h2>Обратная связь</h2>
      <p>Ваше мнение помогает медицинской команде оценивать работу системы.</p>
      {success ? (
        <Success>Обратная связь сохранена</Success>
      ) : (
        <form className="stack" onSubmit={send}>
          {error && <ErrorNotice message={error} />}
          <fieldset disabled={busy}>
            <legend>Согласны с результатом?</legend>
            <div className="feedback-options">
              <button
                type="button"
                aria-pressed={agreement === 'AGREE'}
                className={agreement === 'AGREE' ? 'selected' : ''}
                onClick={() => setAgreement('AGREE')}
              >
                <ThumbsUp size={17} />
                Согласен
              </button>
              <button
                type="button"
                aria-pressed={agreement === 'DISAGREE'}
                className={agreement === 'DISAGREE' ? 'selected' : ''}
                onClick={() => setAgreement('DISAGREE')}
              >
                <ThumbsDown size={17} />
                Не согласен
              </button>
            </div>
            <label className="checkbox-label">
              <input type="checkbox" checked={used} onChange={(e) => setUsed(e.target.checked)} />
              Рекомендация использована
            </label>
            <div className="field">
              <label htmlFor="feedback-comment">Комментарий</label>
              <textarea
                id="feedback-comment"
                rows={4}
                maxLength={2000}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="Без персональных данных пациента"
              />
            </div>
          </fieldset>
          <button className="button primary full" disabled={busy || !agreement}>
            {busy ? 'Отправляем…' : 'Отправить обратную связь'}
          </button>
        </form>
      )}
    </section>
  );
}
export function HistoryPage({ catalog, user }: { catalog?: Catalog; user: User }) {
  const result = useQuery({
    queryKey: ['evaluations'],
    queryFn: () => api<EvaluationView[]>('/evaluations'),
  });
  const [search, setSearch] = useState('');
  const [exportError, setExportError] = useState('');
  const [exporting, setExporting] = useState(false);
  const canExport = user.role === 'CLINICAL_ADMIN' || user.role === 'CLINICAL_PHARMACOLOGIST';
  const name = (evaluation: EvaluationView) =>
    catalog?.nosologies.find(
      (n) => n.nosology_code === (evaluation.nosology_code || evaluation.snapshot?.nosology_code),
    )?.name_ru || 'Клинический случай';
  const filtered = (result.data || [])
    .filter((r) => `${name(r)} ${r.title} ${r.id}`.toLowerCase().includes(search.toLowerCase()))
    .slice()
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  async function exportData(format: 'csv' | 'xlsx') {
    setExporting(true);
    setExportError('');
    try {
      const response = await fetch('/api/v1/exports/evaluations', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format }),
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Ошибка выгрузки');
      }
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `clinical-evaluations.${format}`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setExportError(errorText(e));
    } finally {
      setExporting(false);
    }
  }
  return (
    <>
      <PageTitle
        eyebrow="КЛИНИЧЕСКИЕ СЛУЧАИ"
        title="История расчётов"
        description="Сохранённые результаты, входные данные и версии медицинского контента."
        action={
          <Link className="button primary" href="/app/new">
            Новый расчёт
            <ArrowRight size={16} />
          </Link>
        }
      />
      {exportError && <ErrorNotice message={exportError} />}
      <section className="panel history-panel">
        <div className="table-toolbar">
          <div className="search-input">
            <Search size={18} />
            <input
              aria-label="Поиск по истории"
              placeholder="Нозология или результат…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          {canExport && (
            <div className="button-group">
              <button
                className="button secondary small"
                disabled={exporting}
                onClick={() => exportData('csv')}
              >
                <Download size={15} />
                CSV
              </button>
              <button
                className="button secondary small"
                disabled={exporting}
                onClick={() => exportData('xlsx')}
              >
                <Download size={15} />
                XLSX
              </button>
            </div>
          )}
        </div>
        {result.isPending ? (
          <Loading />
        ) : result.error ? (
          <ErrorNotice message={errorText(result.error)} retry={() => void result.refetch()} />
        ) : !filtered.length ? (
          <Empty
            title={search ? 'Ничего не найдено' : 'История пока пуста'}
            text={
              search
                ? 'Попробуйте другое название нозологии или результата.'
                : 'Завершите клинический расчёт и сохраните его результат.'
            }
            href={search ? undefined : '/app/new'}
          />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Дата и время</th>
                  <th>Нозология / результат</th>
                  <th>Статус</th>
                  <th>Безопасность</th>
                  <th>
                    <span className="sr-only">Действия</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((item) => (
                  <tr key={item.id}>
                    <td className="date-cell">{dateText(item.created_at)}</td>
                    <td>
                      <strong>{name(item)}</strong>
                      <span className="table-subtitle">{item.title}</span>
                    </td>
                    <td>
                      <Badge tone={item.status === 'COMPLETED' ? 'success' : 'warning'}>
                        {statusLabels[item.status]}
                      </Badge>
                    </td>
                    <td>
                      <span className="table-safety">
                        {safetyLabels[item.safety_status] || 'Требуется проверка'}
                      </span>
                    </td>
                    <td>
                      <Link
                        href={`/app/evaluations/${item.id}`}
                        aria-label="Открыть результат"
                        className="icon-button"
                      >
                        <ChevronRight size={19} />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="table-footer">{filtered.length} результатов · Доступ по роли и авторству</div>
      </section>
    </>
  );
}
