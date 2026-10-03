'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  Clock3,
  FileText,
  HelpCircle,
  ListChecks,
  Pill,
  Plus,
  Save,
  Search,
  ShieldAlert,
  Trash2,
  X,
} from 'lucide-react';
import type {
  CaseDraft,
  Drug,
  EvaluationView,
  FactDefinition,
  FactValue,
  Medications,
} from '../../../packages/contracts/src/index';
import { api, errorText, patch, post, type Catalog, type User } from './api';
import { Badge, ErrorNotice, Loading, PageTitle, PrivacyNote, Success } from './ui';
import { ResultContent } from './results';

type Pending = { facts?: Record<string, FactValue>; medications?: Medications };
const pendingSchema = z.object({
  facts: z
    .record(
      z.string(),
      z.object({
        state: z.enum(['KNOWN', 'UNKNOWN', 'NOT_ASSESSED']),
        value: z.union([z.boolean(), z.number(), z.string(), z.null()]),
        unit: z.string().nullable().optional(),
      }),
    )
    .optional(),
  medications: z
    .object({
      state: z.enum(['UNKNOWN', 'KNOWN_NONE', 'KNOWN_LIST']),
      drug_ids: z.array(z.number().int().positive()),
      unrecognized: z.array(z.string()),
    })
    .optional(),
});
export function CaseEditor({ id, catalog, user }: { id: string; catalog?: Catalog; user: User }) {
  const router = useRouter();
  const client = useQueryClient();
  const draftQuery = useQuery({ queryKey: ['case', id], queryFn: () => api<CaseDraft>(`/cases/${id}`) });
  const [pending, setPending] = useState<Pending>({});
  const [restored, setRestored] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [previewRevision, setPreviewRevision] = useState(0);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const storageKey = `medcalc:draft:${user.id}:${id}`;
  const alive = useRef(true);
  const operation = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    setPending({});
    setRestored(false);
    setEditing(null);
    setQuestionIndex(0);
    try {
      const value = localStorage.getItem(storageKey);
      if (value) {
        const parsed = pendingSchema.safeParse(JSON.parse(value));
        if (parsed.success) setPending(parsed.data);
      }
    } catch {
      /* Недоступное хранилище не блокирует серверное сохранение. */
    }
    setRestored(true);
  }, [storageKey]);
  function updatePending(next: Pending) {
    setPending(next);
    setSaved(false);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      /* Серверное сохранение доступно независимо от localStorage. */
    }
  }
  const draft = draftQuery.data;
  const preview = useQuery({
    queryKey: ['preview', id, draft?.updated_at, previewRevision],
    queryFn: ({ signal }) => api<EvaluationView>(`/cases/${id}/evaluate-preview`, { method: 'POST', signal }),
    enabled: !!draft && restored,
    staleTime: Infinity,
  });
  const dirty = !!Object.keys(pending.facts || {}).length || !!pending.medications;
  const facts = { ...draft?.facts, ...pending.facts };
  const medications = pending.medications || draft?.medications;
  const questions = preview.data?.questions || [];
  const question = editing
    ? catalog?.facts.find((f) => f.fact_code === editing)
    : questions[Math.min(questionIndex, Math.max(0, questions.length - 1))];
  const value = question
    ? facts[question.fact_code] || ({ state: 'NOT_ASSESSED', value: null } as FactValue)
    : undefined;
  async function save() {
    if (!draft || operation.current || !dirty) return;
    operation.current = true;
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      const data = await patch<CaseDraft>(`/cases/${id}`, {
        ...pending,
        facts: { ...draft.facts, ...pending.facts },
      });
      if (!alive.current) return;
      client.setQueryData(['case', id], data);
      setPending({});
      try {
        localStorage.removeItem(storageKey);
      } catch {}
      setEditing(null);
      setQuestionIndex(0);
      setPreviewRevision((r) => r + 1);
      setSaved(true);
      void client.invalidateQueries({ queryKey: ['cases'] });
    } catch (e) {
      if (alive.current) setError(errorText(e));
    } finally {
      operation.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function evaluate() {
    if (operation.current || dirty || preview.data?.status !== 'COMPLETED') return;
    operation.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await post<EvaluationView>(`/cases/${id}/evaluations`);
      if (!alive.current) return;
      if (!result.id) throw new Error('Сервер не вернул идентификатор сохранённого результата.');
      client.setQueryData(['evaluation', result.id], result);
      void client.invalidateQueries({ queryKey: ['evaluations'] });
      router.push(`/app/evaluations/${result.id}`);
    } catch (e) {
      if (alive.current) {
        setError(errorText(e));
        setBusy(false);
      }
    } finally {
      operation.current = false;
    }
  }
  if (draftQuery.isPending) return <Loading text="Загружаем клинический случай…" />;
  if (draftQuery.error || !draft)
    return <ErrorNotice message={errorText(draftQuery.error)} retry={() => void draftQuery.refetch()} />;
  const name =
    catalog?.nosologies.find((n) => n.nosology_code === draft.nosology_code)?.name_ru || draft.nosology_code;
  const answerCount = Object.values(draft.facts).filter((f) => f.state !== 'NOT_ASSESSED').length;
  return (
    <>
      <Link href="/app/new" className="back-link">
        <ArrowLeft size={15} />
        Все нозологии
      </Link>
      <PageTitle
        eyebrow="КЛИНИЧЕСКИЙ СЛУЧАЙ"
        title={name}
        description="Последовательно заполните признаки, необходимые для решения."
        action={
          <Badge tone="blue">
            <Clock3 size={13} />
            Черновик
          </Badge>
        }
      />
      <div className="workflow-steps compact">
        <span className="done">
          <b>
            <Check size={13} />
          </b>
          Нозология
        </span>
        <i />
        <span className="current">
          <b>2</b>Клинические данные
        </span>
        <i />
        <span>
          <b>3</b>Результат
        </span>
      </div>
      <div className="case-layout">
        <section className="case-main">
          {error && <ErrorNotice message={error} />}
          {preview.error && (
            <ErrorNotice message={errorText(preview.error)} retry={() => void preview.refetch()} />
          )}
          {!preview.isFetching && preview.data && (
            <span data-testid="case-ready" className="sr-only">
              Расчёт обновлён
            </span>
          )}
          {preview.isPending || preview.isFetching ? (
            <div className="panel">
              <Loading text="Определяем следующий шаг…" />
            </div>
          ) : question ? (
            <section className="question-card panel" data-testid="question-card">
              <div className="question-top">
                <span className="eyebrow">
                  {editing ? 'ИЗМЕНЕНИЕ ОТВЕТА' : `КЛИНИЧЕСКИЕ ДАННЫЕ · ВОПРОС ${answerCount + 1}`}
                </span>
                <span className="question-status">
                  <HelpCircle size={15} />
                  {value?.state === 'NOT_ASSESSED'
                    ? 'Не оценивалось'
                    : value?.state === 'UNKNOWN'
                      ? 'Неизвестно'
                      : 'Ответ указан'}
                </span>
              </div>
              <h2>{question.label_ru}</h2>
              {question.notes && <p className="question-note">{question.notes}</p>}
              <FactInput
                key={question.fact_code}
                fact={question}
                value={value!}
                disabled={busy}
                onChange={(v) =>
                  updatePending({ ...pending, facts: { ...pending.facts, [question.fact_code]: v } })
                }
              />
              <div className="question-footer">
                <span>
                  <ShieldAlert size={15} />
                  Отсутствующий ответ не считается «нет»
                </span>
                {editing ? (
                  <button className="text-button" onClick={() => setEditing(null)}>
                    К текущему вопросу
                  </button>
                ) : (
                  questions.length > 1 && (
                    <div className="question-navigation">
                      <button
                        className="icon-button"
                        aria-label="Предыдущий вопрос"
                        disabled={questionIndex === 0 || busy}
                        onClick={() => setQuestionIndex((v) => v - 1)}
                      >
                        <ArrowLeft size={17} />
                      </button>
                      <span>
                        {questionIndex + 1} / {questions.length}
                      </span>
                      <button
                        className="icon-button"
                        aria-label="Следующий вопрос"
                        disabled={questionIndex >= questions.length - 1 || busy}
                        onClick={() => setQuestionIndex((v) => v + 1)}
                      >
                        <ArrowRight size={17} />
                      </button>
                    </div>
                  )
                )}
              </div>
            </section>
          ) : preview.data?.status === 'COMPLETED' ? (
            <div className="notice success">
              <CheckCircle2 size={22} />
              <div>
                <strong>Клиническая ветвь определена</strong>
                <p>Проверьте сопутствующую терапию и сохраните результат.</p>
              </div>
            </div>
          ) : (
            <div className="notice warning">
              <ShieldAlert size={20} />
              <div>
                <strong>
                  {preview.data?.status === 'FAILED'
                    ? 'Расчёт не выполнен'
                    : 'Для продолжения необходимы данные'}
                </strong>
                <p>{preview.data?.title || 'Проверьте введённые признаки.'}</p>
              </div>
            </div>
          )}
          {medications && (
            <MedicationInput
              value={medications}
              onChange={(v) => updatePending({ ...pending, medications: v })}
              disabled={busy}
            />
          )}
          <div className="save-bar">
            <div>
              {saved ? (
                <Success>Ответы сохранены</Success>
              ) : dirty ? (
                <span className="unsaved">
                  <span />
                  Есть несохранённые изменения
                </span>
              ) : (
                <span className="muted">
                  <Check size={15} />
                  Данные сохранены на сервере
                </span>
              )}
            </div>
            <button className="button primary" disabled={busy || !dirty} onClick={save}>
              <Save size={16} />
              {busy ? 'Сохраняем…' : 'Сохранить ответ'}
            </button>
          </div>
          {dirty && (
            <p className="inline-hint">
              Несохранённый ввод восстановится в этом браузере. Расчёт обновится после сохранения ответа.
            </p>
          )}
          {preview.data && preview.data.status === 'COMPLETED' && !dirty && (
            <ResultContent evaluation={preview.data} compact user={user} />
          )}
          <div className="finish-bar">
            <span>Результат сохранится отдельным снимком данных.</span>
            <button
              className="button primary"
              disabled={busy || dirty || preview.isFetching || preview.data?.status !== 'COMPLETED'}
              onClick={evaluate}
            >
              <FileText size={17} />
              Сохранить результат
              <ArrowRight size={16} />
            </button>
          </div>
          <PrivacyNote />
        </section>
        <aside className="case-context">
          <section className="panel context-panel">
            <div className="context-title">
              <ListChecks size={19} />
              <h2>Контекст случая</h2>
            </div>
            <div className="context-meta">
              <span>Нозология</span>
              <strong>{name}</strong>
              <span>Введено признаков</span>
              <strong>{answerCount}</strong>
            </div>
            <div className="answers-heading">СОХРАНЁННЫЕ ОТВЕТЫ</div>
            {Object.entries(draft.facts).filter(([, v]) => v.state !== 'NOT_ASSESSED').length ? (
              <ul className="answers-list">
                {Object.entries(draft.facts)
                  .filter(([, v]) => v.state !== 'NOT_ASSESSED')
                  .map(([key, v]) => (
                    <li key={key}>
                      <button
                        onClick={() => setEditing(key)}
                        disabled={busy || !catalog?.facts.some((f) => f.fact_code === key)}
                      >
                        <span>{catalog?.facts.find((f) => f.fact_code === key)?.label_ru || key}</span>
                        <strong className={v.state === 'UNKNOWN' ? 'unknown' : ''}>{factText(v)}</strong>
                      </button>
                    </li>
                  ))}
              </ul>
            ) : (
              <p className="context-empty">
                По мере заполнения здесь появятся ответы. К любому из них можно вернуться.
              </p>
            )}
            <div className="context-bottom">
              <ShieldAlert size={17} />
              <span>Неизвестные данные остаются видимыми и не подменяются отрицательными ответами.</span>
            </div>
          </section>
          <section className="context-help">
            <h3>Почему этот вопрос?</h3>
            <p>Сервер запрашивает данные, необходимые для следующего шага текущего клинического алгоритма.</p>
            <p>В сохранённом результате будут доступны объяснение и версии использованных правил.</p>
          </section>
        </aside>
      </div>
    </>
  );
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
function enumLabel(value: string) {
  return (
    ({ GOLD_I_II: 'GOLD I–II', GOLD_III: 'GOLD III', GOLD_IV: 'GOLD IV' } as Record<string, string>)[value] ||
    value
  );
}
function displayUnit(unit: string) {
  return ({ years: 'лет', year: 'лет', days: 'дней', day: 'дней' } as Record<string, string>)[unit] || unit;
}
function FactInput({
  fact,
  value,
  onChange,
  disabled,
}: {
  fact: FactDefinition;
  value: FactValue;
  onChange: (v: FactValue) => void;
  disabled: boolean;
}) {
  const known = (v: boolean | number | string | null): FactValue => ({
    state: 'KNOWN',
    value: v,
    ...(fact.unit ? { unit: fact.unit } : {}),
  });
  const numeric = fact.data_type === 'INTEGER' || fact.data_type === 'DECIMAL';
  return (
    <div className="fact-input">
      <fieldset disabled={disabled}>
        <legend className="sr-only">{fact.label_ru}</legend>
        {fact.data_type === 'BOOLEAN' ? (
          <div className="answer-options">
            {[
              { label: 'Да', v: true, icon: Check },
              { label: 'Нет', v: false, icon: X },
              { label: 'Неизвестно', v: null, icon: HelpCircle },
            ].map(({ label, v, icon: Icon }) => {
              const selected =
                v === null ? value.state === 'UNKNOWN' : value.state === 'KNOWN' && value.value === v;
              return (
                <button
                  type="button"
                  className={`answer-option ${selected ? 'selected' : ''}`}
                  key={label}
                  aria-pressed={selected}
                  onClick={() => onChange(v === null ? { state: 'UNKNOWN', value: null } : known(v))}
                >
                  <span className="radio-dot">{selected && <span />}</span>
                  <span>{label}</span>
                  <Icon size={17} />
                </button>
              );
            })}
          </div>
        ) : (
          <>
            <div className="field">
              <label htmlFor={`fact-${fact.fact_code}`}>{fact.label_ru}</label>
              {fact.data_type === 'ENUM' ? (
                <select
                  id={`fact-${fact.fact_code}`}
                  value={value.state === 'KNOWN' ? String(value.value ?? '') : ''}
                  onChange={(e) =>
                    onChange(e.target.value ? known(e.target.value) : { state: 'NOT_ASSESSED', value: null })
                  }
                >
                  <option value="">Выберите значение</option>
                  {fact.enum_values?.map((v) => (
                    <option key={v} value={v}>
                      {enumLabel(v)}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="unit-field">
                  <input
                    id={`fact-${fact.fact_code}`}
                    type={numeric ? 'number' : fact.data_type === 'DATE' ? 'date' : 'text'}
                    step={fact.data_type === 'INTEGER' ? '1' : 'any'}
                    min={fact.min_value ?? undefined}
                    max={fact.max_value ?? undefined}
                    value={value.state === 'KNOWN' ? String(value.value ?? '') : ''}
                    onChange={(e) =>
                      onChange(
                        e.target.value === ''
                          ? { state: 'NOT_ASSESSED', value: null }
                          : known(numeric ? Number(e.target.value) : e.target.value),
                      )
                    }
                  />
                  {fact.unit && <span>{displayUnit(fact.unit)}</span>}
                </div>
              )}
            </div>
            <button
              type="button"
              className={`unknown-option ${value.state === 'UNKNOWN' ? 'selected' : ''}`}
              aria-pressed={value.state === 'UNKNOWN'}
              onClick={() => onChange({ state: 'UNKNOWN', value: null })}
            >
              <HelpCircle size={16} />
              Неизвестно
            </button>
          </>
        )}
        {value.state !== 'NOT_ASSESSED' && (
          <button
            className="text-button reset-fact"
            type="button"
            onClick={() => onChange({ state: 'NOT_ASSESSED', value: null })}
          >
            Сбросить: не оценивалось
          </button>
        )}
      </fieldset>
    </div>
  );
}
function MedicationInput({
  value,
  onChange,
  disabled,
}: {
  value: Medications;
  onChange: (v: Medications) => void;
  disabled: boolean;
}) {
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [names, setNames] = useState<Record<number, string>>({});
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);
  const results = useQuery({
    queryKey: ['drug-search', search],
    queryFn: ({ signal }) => api<Drug[]>(`/drugs/search?q=${encodeURIComponent(search)}`, { signal }),
    enabled: value.state === 'KNOWN_LIST' && search.length >= 2,
  });
  useEffect(() => {
    let cancelled = false;
    for (const id of value.drug_ids)
      if (!names[id])
        api<Drug>(`/drugs/${id}`)
          .then((drug) => {
            if (!cancelled) setNames((n) => ({ ...n, [id]: drug.generic_name_ru }));
          })
          .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [value.drug_ids, names]);
  const options: { state: Medications['state']; title: string }[] = [
    { state: 'UNKNOWN', title: 'Неизвестно' },
    { state: 'KNOWN_NONE', title: 'Не принимает' },
    { state: 'KNOWN_LIST', title: 'Указать препараты' },
  ];
  return (
    <section className="panel medications-panel">
      <div className="panel-heading">
        <div className="section-title-icon">
          <span>
            <Pill size={21} />
          </span>
          <div>
            <h2>Сопутствующая терапия</h2>
            <p>Для проверки лекарственных взаимодействий</p>
          </div>
        </div>
      </div>
      <fieldset disabled={disabled}>
        <legend className="sr-only">Состояние сопутствующей терапии</legend>
        <div className="segmented">
          {options.map((option) => (
            <button
              type="button"
              aria-pressed={value.state === option.state}
              className={value.state === option.state ? 'selected' : ''}
              key={option.state}
              onClick={() =>
                onChange({
                  state: option.state,
                  drug_ids: option.state === 'KNOWN_LIST' ? value.drug_ids : [],
                  unrecognized: option.state === 'KNOWN_LIST' ? value.unrecognized : [],
                })
              }
            >
              {option.title}
            </button>
          ))}
        </div>
        {value.state === 'UNKNOWN' && (
          <p className="medication-warning">
            <ShieldAlert size={16} />
            Список неизвестен. Проверка взаимодействий будет неполной.
          </p>
        )}
        {value.state === 'KNOWN_NONE' && (
          <p className="medication-note">
            <Check size={16} />
            Отмечено отсутствие сопутствующих препаратов.
          </p>
        )}
        {value.state === 'KNOWN_LIST' && (
          <div className="medication-search">
            <label htmlFor="drug-search">Найти препарат по названию</label>
            <div className="search-input">
              <Search size={18} />
              <input
                id="drug-search"
                value={query}
                placeholder="Введите не менее двух символов"
                autoComplete="off"
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            {search.length >= 2 && (
              <div className="search-results" aria-label="Найденные препараты">
                {results.isFetching ? (
                  <Loading text="Ищем в справочнике…" />
                ) : results.error ? (
                  <ErrorNotice message={errorText(results.error)} />
                ) : (
                  results.data
                    ?.filter((d) => !value.drug_ids.includes(d.drug_id))
                    .map((drug) => (
                      <button
                        type="button"
                        key={drug.drug_id}
                        onClick={() => {
                          onChange({ ...value, drug_ids: [...value.drug_ids, drug.drug_id] });
                          setNames((n) => ({ ...n, [drug.drug_id]: drug.generic_name_ru }));
                          setQuery('');
                          setSearch('');
                        }}
                      >
                        <Pill size={15} />
                        <span>{drug.generic_name_ru}</span>
                        <Plus size={16} />
                      </button>
                    ))
                )}
                {!results.isFetching && query.trim() && !value.unrecognized.includes(query.trim()) && (
                  <button
                    type="button"
                    className="unrecognized-add"
                    onClick={() => {
                      onChange({ ...value, unrecognized: [...value.unrecognized, query.trim()] });
                      setQuery('');
                      setSearch('');
                    }}
                  >
                    <Plus size={15} />
                    Добавить «{query.trim()}» как нераспознанный
                  </button>
                )}
              </div>
            )}
            <div className="medication-tags">
              {value.drug_ids.map((id) => (
                <span className="medication-tag" key={id}>
                  <Pill size={13} />
                  {names[id] || `Препарат №${id}`}
                  <button
                    aria-label={`Удалить ${names[id] || id}`}
                    onClick={() => onChange({ ...value, drug_ids: value.drug_ids.filter((d) => d !== id) })}
                  >
                    <Trash2 size={13} />
                  </button>
                </span>
              ))}
              {value.unrecognized.map((name) => (
                <span className="medication-tag unrecognized" key={name}>
                  {name}
                  <button
                    aria-label={`Удалить ${name}`}
                    onClick={() =>
                      onChange({ ...value, unrecognized: value.unrecognized.filter((d) => d !== name) })
                    }
                  >
                    <Trash2 size={13} />
                  </button>
                </span>
              ))}
            </div>
            {value.unrecognized.length > 0 && (
              <p className="medication-warning">
                <ShieldAlert size={16} />
                Для нераспознанных препаратов автоматическая проверка взаимодействий не гарантирована.
              </p>
            )}
            {value.drug_ids.length === 0 && value.unrecognized.length === 0 && (
              <p className="inline-hint">
                Добавьте хотя бы один препарат или выберите другое состояние списка.
              </p>
            )}
          </div>
        )}
      </fieldset>
    </section>
  );
}
