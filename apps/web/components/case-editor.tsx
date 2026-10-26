'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
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
import { api, ApiError, errorText, post, type Catalog, type User } from './api';
import { Badge, ErrorNotice, Loading, PageTitle, PrivacyNote } from './ui';
import { Feedback, ResultContent, type FeedbackInput } from './results';
import { clinicalText, factText, enumLabel, displayUnit } from './clinical-text';
import { useCaseDraft } from './use-case-draft';

export function CaseEditor(props: { id: string; catalog?: Catalog; user: User }) {
  return <CaseEditorSession key={`${props.user.id}:${props.id}`} {...props} />;
}
function CaseEditorSession({ id, catalog, user }: { id: string; catalog?: Catalog; user: User }) {
  const router = useRouter();
  const client = useQueryClient();
  const draftQuery = useQuery({ queryKey: ['case', id], queryFn: () => api<CaseDraft>(`/cases/${id}`) });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [previewRevision, setPreviewRevision] = useState(0);
  const [block, setBlock] = useState<FactDefinition[]>([]);
  const [editing, setEditing] = useState<{ fact: FactDefinition; value: FactValue } | null>(null);
  const [savedResult, setSavedResult] = useState<EvaluationView>();
  const operation = useRef(false);
  const anchor = useRef<HTMLElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const changes = useCaseDraft(id, user.id, (data) => {
    client.setQueryData(['case', id], data);
    setPreviewRevision((r) => r + 1);
    void client.invalidateQueries({ queryKey: ['cases'] });
  });
  const draft = draftQuery.data;
  const preview = useQuery({
    queryKey: ['preview', id, draft?.updated_at, previewRevision],
    queryFn: ({ signal }) => api<EvaluationView>(`/cases/${id}/evaluate-preview`, { method: 'POST', signal }),
    enabled: !!draft && changes.restored && !changes.saving,
    staleTime: Infinity,
  });
  useEffect(() => {
    if (!preview.data || changes.saving) return;
    const next = preview.data.questions;
    setBlock((previous) =>
      changes.dirty && previous.length
        ? previous
        : next.length && next.every((q) => previous.some((p) => p.fact_code === q.fact_code))
          ? previous
          : next,
    );
  }, [preview.data, changes.dirty, changes.saving]);
  const blockKey = block.map((q) => q.fact_code).join(',');
  const lastBlock = useRef('');
  useEffect(() => {
    if (blockKey && lastBlock.current && blockKey !== lastBlock.current && !editing) {
      anchor.current?.focus({ preventScroll: true });
      anchor.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    if (blockKey) lastBlock.current = blockKey;
  }, [blockKey, editing]);
  const facts = { ...draft?.facts, ...changes.pending.facts };
  const medications = changes.pending.medications || draft?.medications;
  const answers = Object.entries(draft?.facts || {}).filter(([, v]) => v.state !== 'NOT_ASSESSED');
  const locked = busy || changes.saving;
  const ready =
    !changes.dirty &&
    !changes.saving &&
    !preview.isFetching &&
    preview.data?.status === 'COMPLETED' &&
    !editing;
  function edit(code: string) {
    const fact = catalog?.facts.find((f) => f.fact_code === code);
    if (fact && draft && !locked && !changes.dirty) setEditing({ fact, value: draft.facts[code] });
    anchor.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  async function saveResult(feedback?: FeedbackInput) {
    if (operation.current || !ready || !preview.data) return;
    operation.current = true;
    setBusy(true);
    setError('');
    try {
      const result =
        !feedback && savedResult?.preview_token === preview.data.preview_token && savedResult?.id
          ? savedResult
          : await post<EvaluationView>(`/cases/${id}/evaluations`, {
              preview_token: preview.data.preview_token,
              ...(feedback ? { feedback } : {}),
            });
      if (!result.id) throw new Error('Сервер не вернул идентификатор результата.');
      client.setQueryData(['evaluation', result.id], result);
      setSavedResult(result);
      void client.invalidateQueries({ queryKey: ['evaluations'] });
      if (!feedback) router.push(`/app/evaluations/${result.id}`);
    } catch (e) {
      setError(errorText(e));
      if (e instanceof ApiError && e.code === 'PREVIEW_CHANGED') {
        await draftQuery.refetch();
        setPreviewRevision((r) => r + 1);
      }
      if (feedback) throw e;
    } finally {
      operation.current = false;
      setBusy(false);
    }
  }
  if (draftQuery.isPending) return <Loading text="Загружаем клинический случай…" />;
  if (draftQuery.error || !draft)
    return <ErrorNotice message={errorText(draftQuery.error)} retry={() => void draftQuery.refetch()} />;
  const name =
    catalog?.nosologies.find((n) => n.nosology_code === draft.nosology_code)?.name_ru || draft.nosology_code;
  const unknown = (preview.data?.questions || []).filter(
    (q) => draft.facts[q.fact_code]?.state === 'UNKNOWN',
  );
  const fields = editing ? [editing.fact] : block;
  return (
    <>
      <Link href="/app/new" className="back-link">
        <ArrowLeft size={15} />
        Все нозологии
      </Link>
      <PageTitle
        eyebrow="КЛИНИЧЕСКИЙ СЛУЧАЙ"
        title={name}
        description="Ответы сохраняются автоматически после выбора или завершения ввода."
        action={
          <Badge tone="blue">
            <Clock3 size={13} />
            Черновик
          </Badge>
        }
      />
      <div className="case-layout">
        <section className="case-main">
          {error && <ErrorNotice message={error} />}
          {changes.error && (
            <ErrorNotice
              message={changes.error}
              retry={() => {
                if (form.current?.reportValidity()) changes.retry();
              }}
            />
          )}
          {preview.error && (
            <ErrorNotice message={errorText(preview.error)} retry={() => void preview.refetch()} />
          )}
          {!preview.isFetching && preview.data && !changes.saving && !changes.dirty && (
            <span data-testid="case-ready" className="sr-only">
              Расчёт обновлён
            </span>
          )}
          <div className="case-navigation">
            <button
              className="button secondary small"
              disabled={locked || changes.dirty || !!editing || !answers.length}
              onClick={() => edit(answers[answers.length - 1][0])}
            >
              <ArrowLeft size={16} />
              Назад
            </button>
            <span role="status" className="muted">
              {changes.saving
                ? 'Сохраняем ответы…'
                : changes.dirty
                  ? 'Есть несохранённый ввод'
                  : preview.isFetching
                    ? 'Обновляем расчёт…'
                    : 'Ответы сохранены'}
            </span>
          </div>
          {!!unknown.length && !changes.dirty && !changes.saving && !editing && (
            <div className="notice warning" data-testid="missing-input-notice">
              <HelpCircle size={21} />
              <div>
                <strong>Ответ «неизвестно» сохранён</strong>
                <p>
                  Текущий алгоритм требует уточнить: {unknown.map((q) => clinicalText(q.label_ru)).join('; ')}
                  . Укажите данные ниже, когда они будут доступны. Можно вернуться к этому черновику позже.
                </p>
              </div>
            </div>
          )}
          <form
            ref={form}
            onSubmit={(e) => {
              e.preventDefault();
              if (editing) {
                changes.fact(editing.fact.fact_code, editing.value, true);
                setEditing(null);
              } else changes.retry();
            }}
          >
            <section ref={anchor} tabIndex={-1} className="panel question-card" data-testid="question-card">
              {fields.length ? (
                <>
                  <div className="question-top">
                    <span className="eyebrow">
                      {editing
                        ? 'ИЗМЕНЕНИЕ ОТВЕТА'
                        : fields.length > 1
                          ? 'ДАННЫЕ ДЛЯ СЛЕДУЮЩЕГО ШАГА'
                          : 'КЛИНИЧЕСКИЕ ДАННЫЕ'}
                    </span>
                  </div>
                  {fields.map((question) => (
                    <div
                      className="grouped-fact"
                      data-testid="fact-field"
                      data-state={(editing?.value || facts[question.fact_code])?.state || 'NOT_ASSESSED'}
                      key={question.fact_code}
                    >
                      <h2>{clinicalText(question.label_ru)}</h2>
                      {question.notes && (
                        <details className="question-help">
                          <summary>Пояснение к вопросу</summary>
                          <p>{clinicalText(question.notes)}</p>
                        </details>
                      )}
                      <FactInput
                        fact={question}
                        value={
                          editing?.value ||
                          facts[question.fact_code] || { state: 'NOT_ASSESSED', value: null }
                        }
                        disabled={busy}
                        onChange={(value, commit = true) =>
                          editing
                            ? setEditing({ ...editing, value })
                            : changes.fact(question.fact_code, value, commit)
                        }
                        onCommit={() => {
                          if (!editing) changes.commitFact(question.fact_code);
                        }}
                      />
                    </div>
                  ))}
                  {editing && (
                    <div className="edit-actions">
                      <button className="button primary" type="submit" disabled={locked}>
                        Сохранить изменения
                      </button>
                      <button
                        className="button secondary"
                        type="button"
                        disabled={locked}
                        onClick={() => {
                          setEditing(null);
                          anchor.current?.focus({ preventScroll: true });
                        }}
                      >
                        Отменить изменения
                      </button>
                    </div>
                  )}
                </>
              ) : preview.isPending || preview.isFetching ? (
                <Loading text="Определяем следующий шаг…" />
              ) : (
                <div className="section-title-icon">
                  <CheckCircle2 size={22} />
                  <div>
                    <h2>
                      {preview.data?.status === 'COMPLETED'
                        ? 'Данные для расчёта заполнены'
                        : 'Для продолжения необходимы данные'}
                    </h2>
                    <p>
                      {preview.data?.status === 'COMPLETED'
                        ? 'Проверьте результат ниже.'
                        : preview.data?.title}
                    </p>
                  </div>
                </div>
              )}
            </section>
            {changes.dirty && !changes.saving && !editing && (
              <div className="save-bar">
                <span className="inline-hint">
                  Ввод сохранён в этом браузере. Завершите поле или повторите сохранение.
                </span>
                <button className="button secondary" type="submit">
                  <Save size={16} />
                  {changes.error ? 'Повторить сохранение' : 'Сохранить ввод'}
                </button>
              </div>
            )}
          </form>
          {medications && (
            <MedicationInput
              value={medications}
              onChange={changes.medications}
              disabled={busy || !!editing}
            />
          )}
          {ready && preview.data && (
            <>
              <ResultContent evaluation={preview.data} compact user={user} />
              <Feedback
                key={preview.data.preview_token || preview.data.copy_text}
                onSubmit={async (input) => {
                  await saveResult(input);
                }}
                disabled={busy}
              />
              {savedResult?.id && savedResult.preview_token === preview.data.preview_token && (
                <Link className="text-link" href={`/app/evaluations/${savedResult.id}`}>
                  Открыть сохранённый результат
                  <ArrowRight size={16} />
                </Link>
              )}
            </>
          )}
          <div className="finish-bar">
            <span>Результат сохранится отдельным снимком данных.</span>
            <button className="button primary" disabled={busy || !ready} onClick={() => void saveResult()}>
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
              <h2>Сохранённые ответы</h2>
            </div>
            {answers.length ? (
              <ul className="answers-list">
                {answers.map(([code, value]) => (
                  <li key={code}>
                    <button
                      disabled={
                        locked ||
                        changes.dirty ||
                        !!editing ||
                        !catalog?.facts.some((f) => f.fact_code === code)
                      }
                      onClick={() => edit(code)}
                    >
                      <span>
                        {clinicalText(catalog?.facts.find((f) => f.fact_code === code)?.label_ru || code)}
                      </span>
                      <strong className={value.state === 'UNKNOWN' ? 'unknown' : ''}>
                        {factText(value)}
                      </strong>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="context-empty">Здесь появятся ответы. Нажмите на ответ, чтобы изменить его.</p>
            )}
          </section>
        </aside>
      </div>
    </>
  );
}

function FactInput({
  fact,
  value,
  onChange,
  onCommit,
  disabled,
}: {
  fact: FactDefinition;
  value: FactValue;
  onChange: (v: FactValue, commit?: boolean) => void;
  onCommit: () => void;
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
        <legend className="sr-only">{clinicalText(fact.label_ru)}</legend>
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
              <label className="sr-only" htmlFor={`fact-${fact.fact_code}`}>
                {clinicalText(fact.label_ru)}
              </label>
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
                    onBlur={(e) => {
                      if (e.currentTarget.reportValidity()) onCommit();
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        e.currentTarget.blur();
                      }
                    }}
                    onChange={(e) =>
                      onChange(
                        e.target.value === ''
                          ? { state: 'NOT_ASSESSED', value: null }
                          : known(numeric ? Number(e.target.value) : e.target.value),
                        false,
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
  const [expanded, setExpanded] = useState(value.state === 'UNKNOWN');
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
        <button
          type="button"
          className="text-button"
          aria-expanded={expanded}
          disabled={disabled}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? 'Свернуть' : 'Изменить сопутствующую терапию'}
          <ChevronDown size={16} />
        </button>
      </div>
      {!expanded && (
        <div className="medications-summary">
          <p>
            {value.state === 'UNKNOWN'
              ? 'Список неизвестен. Проверка взаимодействий будет неполной.'
              : value.state === 'KNOWN_NONE'
                ? 'Не принимает сопутствующие препараты'
                : [...value.drug_ids.map((id) => names[id] || `Препарат №${id}`), ...value.unrecognized].join(
                    ', ',
                  ) || 'Список препаратов не заполнен'}
          </p>
          {!!value.unrecognized.length && (
            <p className="medication-warning">
              Есть нераспознанные препараты. Автоматическая проверка взаимодействий не гарантирована.
            </p>
          )}
        </div>
      )}
      <fieldset disabled={disabled} hidden={!expanded}>
        <legend className="sr-only">Состояние сопутствующей терапии</legend>
        <div className="segmented">
          {options.map((option) => (
            <button
              type="button"
              aria-pressed={value.state === option.state}
              className={value.state === option.state ? 'selected' : ''}
              key={option.state}
              onClick={() => {
                onChange({
                  state: option.state,
                  drug_ids: option.state === 'KNOWN_LIST' ? value.drug_ids : [],
                  unrecognized: option.state === 'KNOWN_LIST' ? value.unrecognized : [],
                });
                if (option.state !== 'KNOWN_LIST') setExpanded(false);
              }}
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
