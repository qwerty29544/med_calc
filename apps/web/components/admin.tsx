'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  FileJson,
  GitBranch,
  Plus,
  ShieldAlert,
  Upload,
  Users,
} from 'lucide-react';
import type { ValidationReport } from '../../../packages/contracts/src/index';
import { api, errorText, patch, post, roleLabel, type Role, type User } from './api';
import { Badge, Empty, ErrorNotice, Loading, PageTitle, Success } from './ui';
interface PackageView {
  id: string;
  package_type: string;
  version: string;
  status: string;
  sha256: string;
  active: boolean;
  validation_report?: ValidationReport;
  payload?: unknown;
}
const packageStatus: Record<string, string> = {
  DRAFT: 'Черновик',
  IN_REVIEW: 'На проверке',
  VALIDATED: 'Проверен',
  PUBLISHED: 'Опубликован',
  RETIRED: 'Архивный',
};
export function ContentPage() {
  const query = useQuery({ queryKey: ['packages'], queryFn: () => api<PackageView[]>('/admin/packages') });
  const client = useQueryClient();
  const [json, setJson] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [imported, setImported] = useState(false);
  async function loadFile(file?: File) {
    if (!file) return;
    setError('');
    try {
      if (file.size > 8 * 1024 * 1024) throw new Error('Размер пакета не должен превышать 8 МБ.');
      setJson(await file.text());
    } catch (e) {
      setError(errorText(e));
    }
  }
  async function importPackage(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setImported(false);
    try {
      let payload: unknown;
      try {
        payload = JSON.parse(json);
      } catch {
        throw new Error('Некорректный JSON. Проверьте кавычки, запятые и структуру файла.');
      }
      await post<PackageView>('/admin/packages/import', { payload });
      await client.invalidateQueries({ queryKey: ['packages'] });
      setImported(true);
      setJson('');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageTitle
        eyebrow="АДМИНИСТРИРОВАНИЕ"
        title="Медицинский контент"
        description="Импорт, проверка и публикация версий клинических правил."
      />
      <div className="notice neutral">
        <GitBranch size={20} />
        <div>
          <strong>Управляемый жизненный цикл</strong>
          <p>Черновик → проверка → валидация → публикация → активация. Опубликованные версии неизменяемы.</p>
        </div>
      </div>
      <div className="admin-content-grid">
        <section className="panel packages-panel">
          <div className="panel-heading">
            <div>
              <h2>Пакеты контента</h2>
              <p>Активная версия используется для новых расчётов</p>
            </div>
            <Badge>{query.data?.length || 0}</Badge>
          </div>
          {query.isPending ? (
            <Loading />
          ) : query.error ? (
            <ErrorNotice message={errorText(query.error)} retry={() => void query.refetch()} />
          ) : !query.data?.length ? (
            <Empty
              title="Пакеты ещё не загружены"
              text="Импортируйте подготовленный JSON-пакет и запустите проверку."
            />
          ) : (
            <div className="package-list">
              {query.data.map((item) => (
                <Link href={`/admin/content/${item.id}`} className="package-row" key={item.id}>
                  <span className="package-icon">
                    <FileJson size={23} />
                  </span>
                  <div>
                    <strong>Клинические правила · {item.version}</strong>
                    <span>{item.package_type}</span>
                    <code>{item.sha256?.slice(0, 16)}…</code>
                  </div>
                  <div className="package-badges">
                    <Badge
                      tone={
                        item.status === 'PUBLISHED'
                          ? 'success'
                          : item.status === 'VALIDATED'
                            ? 'blue'
                            : 'neutral'
                      }
                    >
                      {packageStatus[item.status] || item.status}
                    </Badge>
                    {item.active && <Badge tone="success">Активен</Badge>}
                  </div>
                  <ChevronRight size={17} />
                </Link>
              ))}
            </div>
          )}
        </section>
        <section className="panel import-panel">
          <span className="admin-icon">
            <Upload size={23} />
          </span>
          <h2>Импортировать пакет</h2>
          <p>Загрузите JSON или вставьте подготовленные данные.</p>
          <form className="stack" onSubmit={importPackage}>
            {error && <ErrorNotice message={error} />}
            {imported && <Success>Пакет импортирован. Запустите валидацию.</Success>}
            <label className="file-upload">
              <Upload size={19} />
              <span>Выбрать JSON-файл</span>
              <input
                type="file"
                accept=".json,application/json"
                onChange={(e) => void loadFile(e.target.files?.[0])}
                disabled={busy}
              />
            </label>
            <div className="field">
              <label htmlFor="package-json">Содержимое пакета</label>
              <textarea
                id="package-json"
                rows={10}
                className="code-input"
                placeholder={'{\n  "contract_version": "0.1.0",\n  "package_type": "CLINICAL_RULESET"\n}'}
                value={json}
                onChange={(e) => setJson(e.target.value)}
                required
                spellCheck={false}
                disabled={busy}
              />
            </div>
            <button className="button primary full" disabled={busy || !json.trim()}>
              <Upload size={16} />
              {busy ? 'Импортируем…' : 'Импортировать JSON'}
            </button>
            <p className="inline-hint">Импорт не публикует и не активирует пакет.</p>
          </form>
        </section>
      </div>
    </>
  );
}
export function ContentDetail({ id }: { id: string }) {
  const client = useQueryClient();
  const packages = useQuery({ queryKey: ['packages'], queryFn: () => api<PackageView[]>('/admin/packages') });
  const validation = useQuery({
    queryKey: ['validation', id],
    queryFn: () => api<ValidationReport>(`/admin/packages/${id}/validation`),
    enabled: !!packages.data?.some((p) => p.id === id && p.validation_report),
  });
  const item = packages.data?.find((p) => p.id === id);
  const report = validation.data || item?.validation_report;
  const [approval, setApproval] = useState('');
  const [golden, setGolden] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [busy, setBusy] = useState(false);
  async function action(kind: 'validate' | 'publish' | 'activate') {
    setError('');
    setSuccess('');
    setBusy(true);
    try {
      let body: unknown = undefined;
      if (kind === 'publish') {
        if (approval.trim().length < 20)
          throw new Error('Комментарий клинического утверждения должен содержать не менее 20 символов.');
        let cases: unknown;
        try {
          cases = JSON.parse(golden);
        } catch {
          throw new Error('Эталонные случаи должны быть корректным JSON-массивом.');
        }
        if (!Array.isArray(cases) || !cases.length)
          throw new Error('Укажите непустой массив утверждённых эталонных случаев.');
        body = { approval_note: approval.trim(), golden_cases: cases };
      }
      const result = await post<ValidationReport | PackageView>(`/admin/packages/${id}/${kind}`, body);
      if (kind === 'validate' && 'valid' in result) client.setQueryData(['validation', id], result);
      await client.invalidateQueries({ queryKey: ['packages'] });
      await client.invalidateQueries({ queryKey: ['validation', id] });
      await client.invalidateQueries({ queryKey: ['catalog'] });
      setSuccess(
        kind === 'validate'
          ? 'Проверка выполнена. Ознакомьтесь с отчётом.'
          : kind === 'publish'
            ? 'Пакет опубликован. Теперь его можно активировать.'
            : 'Версия активирована для новых расчётов.',
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  if (packages.isPending) return <Loading />;
  if (packages.error)
    return <ErrorNotice message={errorText(packages.error)} retry={() => void packages.refetch()} />;
  if (!item)
    return (
      <Empty
        title="Пакет не найден"
        text="Проверьте ссылку или вернитесь к списку пакетов."
        href="/admin/content"
        action="К пакетам"
      />
    );
  const published = item.status === 'PUBLISHED' || item.status === 'RETIRED';
  return (
    <>
      <Link href="/admin/content" className="back-link">
        <ArrowLeft size={15} />
        Пакеты контента
      </Link>
      <PageTitle
        eyebrow="ВЕРСИЯ МЕДИЦИНСКОГО КОНТЕНТА"
        title={`Клинические правила · ${item.version}`}
        description="Проверка и утверждение подготовленного пакета."
        action={
          <div className="button-group">
            <Badge tone={published ? 'success' : 'neutral'}>
              {packageStatus[item.status] || item.status}
            </Badge>
            {item.active && <Badge tone="success">Активен</Badge>}
          </div>
        }
      />
      {error && <ErrorNotice message={error} />}
      {success && <Success>{success}</Success>}
      <div className="admin-content-grid">
        <div>
          <section className="panel package-detail">
            <h2>Паспорт версии</h2>
            <dl className="metadata-list">
              <div>
                <dt>Тип пакета</dt>
                <dd>{item.package_type}</dd>
              </div>
              <div>
                <dt>Версия</dt>
                <dd>{item.version}</dd>
              </div>
              <div>
                <dt>Контрольная сумма SHA-256</dt>
                <dd>
                  <code className="hash">{item.sha256}</code>
                </dd>
              </div>
            </dl>
            {!published && (
              <button className="button secondary" disabled={busy} onClick={() => action('validate')}>
                <ClipboardCheck size={17} />
                {busy ? 'Обработка…' : 'Запустить валидацию'}
              </button>
            )}
          </section>
          <section className="panel validation-panel">
            <div className="panel-heading">
              <div>
                <h2>Отчёт валидации</h2>
                <p>Структурные, семантические и клинические проверки</p>
              </div>
              {report && (
                <Badge tone={report.valid ? 'success' : 'danger'}>
                  {report.valid ? 'Проверка пройдена' : 'Есть ошибки'}
                </Badge>
              )}
            </div>
            {validation.error && <ErrorNotice message={errorText(validation.error)} />}
            {!report ? (
              <p className="muted">Проверка ещё не запускалась.</p>
            ) : (
              <>
                {report.errors.length === 0 && (
                  <div className="success-note">
                    <CheckCircle2 size={17} />
                    Структурных и семантических ошибок не найдено.
                  </div>
                )}
                <ValidationItems items={report.errors} danger />
                <ValidationItems items={report.warnings} />
              </>
            )}
          </section>
          {item.payload !== undefined && (
            <details className="panel details-panel">
              <summary>
                <FileJson size={18} />
                <span>Исходный пакет · только чтение</span>
                <ChevronRight size={17} />
              </summary>
              <div className="details-body">
                <pre className="json-view">{JSON.stringify(item.payload, null, 2)}</pre>
              </div>
            </details>
          )}
        </div>
        <section className="panel publish-panel">
          <span className="admin-icon">
            <ShieldAlert size={23} />
          </span>
          <h2>{published ? 'Активация версии' : 'Клиническое утверждение'}</h2>
          {published ? (
            <>
              <p>Опубликованный пакет не изменяется. Активация применит эту версию к новым расчётам.</p>
              <button
                className="button primary full"
                disabled={busy || item.active || item.status !== 'PUBLISHED'}
                onClick={() => action('activate')}
              >
                {item.active ? (
                  <>
                    <Check size={17} />
                    Версия активна
                  </>
                ) : (
                  'Активировать версию'
                )}
              </button>
            </>
          ) : (
            <>
              <p>
                Для публикации нужны успешная валидация, утверждение и эталонные случаи для каждой активной
                нозологии.
              </p>
              <form
                className="stack"
                onSubmit={(e) => {
                  e.preventDefault();
                  void action('publish');
                }}
              >
                <div className="field">
                  <label htmlFor="approval-note">Комментарий клинического утверждения</label>
                  <textarea
                    id="approval-note"
                    rows={4}
                    minLength={20}
                    required
                    value={approval}
                    onChange={(e) => setApproval(e.target.value)}
                    placeholder="Кем, когда и на каком основании проверен пакет"
                    disabled={busy}
                  />
                </div>
                <div className="field">
                  <label htmlFor="golden-cases">Утверждённые эталонные случаи · JSON</label>
                  <textarea
                    id="golden-cases"
                    rows={9}
                    className="code-input"
                    value={golden}
                    onChange={(e) => setGolden(e.target.value)}
                    placeholder={
                      '[\n  {"name": "…", "case": {…},\n   "expected": {"status": "…", "outcome": {…}}}\n]'
                    }
                    required
                    spellCheck={false}
                    disabled={busy}
                  />
                </div>
                <p className="inline-hint">
                  Сервер выполнит каждый случай и сравнит фактический результат с ожидаемым. Технические
                  демонстрационные сценарии не заменяют клиническое утверждение.
                </p>
                <button
                  className="button primary full"
                  disabled={busy || !report?.valid || item.status !== 'VALIDATED'}
                >
                  Опубликовать утверждённый пакет
                </button>
              </form>
            </>
          )}
        </section>
      </div>
    </>
  );
}
function ValidationItems({ items, danger = false }: { items: ValidationReport['errors']; danger?: boolean }) {
  return (
    <ul className={`validation-list ${danger ? 'errors' : 'warnings'}`}>
      {items.map((item, index) => (
        <li key={index}>
          <ShieldAlert size={16} />
          <div>
            <strong>{item.message}</strong>
            <code>
              {item.code}
              {item.path ? ` · ${item.path}` : ''}
            </code>
          </div>
        </li>
      ))}
    </ul>
  );
}
export function UsersPage() {
  const client = useQueryClient();
  const users = useQuery({ queryKey: ['users'], queryFn: () => api<User[]>('/admin/users') });
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [busy, setBusy] = useState(false);
  async function change(id: string, data: { role?: Role; active?: boolean }) {
    setBusy(true);
    setError('');
    setSuccess('');
    try {
      await patch(`/admin/users/${id}`, data);
      await client.invalidateQueries({ queryKey: ['users'] });
      setSuccess('Настройки пользователя сохранены.');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    setError('');
    setSuccess('');
    try {
      await post('/admin/users', {
        login: data.get('login'),
        name: data.get('name'),
        password: data.get('password'),
        role: data.get('role'),
      });
      await client.invalidateQueries({ queryKey: ['users'] });
      form.reset();
      setSuccess('Пользователь создан.');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageTitle
        eyebrow="СИСТЕМНОЕ АДМИНИСТРИРОВАНИЕ"
        title="Пользователи"
        description="Управление учётными записями, ролями и доступом к системе."
      />
      {error && <ErrorNotice message={error} />}
      {success && <Success>{success}</Success>}
      <div className="admin-content-grid users-grid">
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Учётные записи</h2>
              <p>Права применяются сервером для каждого запроса</p>
            </div>
            <Badge>{users.data?.length || 0}</Badge>
          </div>
          {users.isPending ? (
            <Loading />
          ) : users.error ? (
            <ErrorNotice message={errorText(users.error)} />
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Пользователь</th>
                    <th>Роль</th>
                    <th>Доступ</th>
                  </tr>
                </thead>
                <tbody>
                  {users.data?.map((user) => (
                    <tr key={user.id}>
                      <td>
                        <strong>{user.name}</strong>
                        <span className="table-subtitle">{user.login}</span>
                      </td>
                      <td>
                        <select
                          aria-label={`Роль пользователя ${user.login}`}
                          value={user.role}
                          disabled={busy}
                          onChange={(e) => change(user.id, { role: e.target.value as Role })}
                        >
                          {Object.entries(roleLabel).map(([role, label]) => (
                            <option key={role} value={role}>
                              {label}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <button
                          className={`access-toggle ${user.active === false ? 'inactive' : ''}`}
                          aria-label={`${user.active === false ? 'Включить' : 'Отключить'} доступ ${user.login}`}
                          onClick={() => change(user.id, { active: user.active === false })}
                          disabled={busy}
                        >
                          <span />
                          {user.active === false ? 'Отключён' : 'Активен'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <section className="panel import-panel">
          <span className="admin-icon">
            <Users size={23} />
          </span>
          <h2>Новый пользователь</h2>
          <p>Выдайте доступ с подходящей рабочей ролью.</p>
          <form className="stack" onSubmit={create}>
            <fieldset disabled={busy} className="stack">
              <div className="field">
                <label htmlFor="new-user-name">Отображаемое имя</label>
                <input id="new-user-name" name="name" required maxLength={100} autoComplete="off" />
              </div>
              <div className="field">
                <label htmlFor="new-user-login">Логин</label>
                <input
                  id="new-user-login"
                  name="login"
                  required
                  minLength={3}
                  maxLength={80}
                  autoComplete="off"
                  pattern="[A-Za-z0-9_.-]+"
                  title="Латинские буквы, цифры, точка, дефис и подчёркивание"
                />
              </div>
              <div className="field">
                <label htmlFor="new-user-password">Начальный пароль</label>
                <input
                  id="new-user-password"
                  name="password"
                  type="password"
                  required
                  minLength={12}
                  autoComplete="new-password"
                />
                <span className="inline-hint">Не менее 12 символов.</span>
              </div>
              <div className="field">
                <label htmlFor="new-user-role">Роль</label>
                <select id="new-user-role" name="role" defaultValue="DOCTOR">
                  {Object.entries(roleLabel).map(([role, label]) => (
                    <option key={role} value={role}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
            </fieldset>
            <button className="button primary full" disabled={busy}>
              <Plus size={16} />
              {busy ? 'Сохраняем…' : 'Создать пользователя'}
            </button>
          </form>
        </section>
      </div>
    </>
  );
}
