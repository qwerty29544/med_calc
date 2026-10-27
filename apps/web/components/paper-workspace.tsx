'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowRight,
  BookOpen,
  Check,
  ChevronRight,
  FileClock,
  History,
  LayoutDashboard,
  LogOut,
  Menu,
  Plus,
  Search,
  Settings,
  Users,
  X,
} from 'lucide-react';
import type { CaseDraft } from '../../../packages/contracts/src/index';
import { api, ApiError, dateText, errorText, post, roleLabel, type Catalog, type User } from './api';
import { Badge, Empty, ErrorNotice, Loading, PageTitle } from './ui';
import { CaseEditor } from './case-editor';
import { HistoryPage, SavedResult } from './results';
import { ContentDetail, ContentPage, UsersPage } from './admin';
import { AppearanceProvider } from './preferences';
import { SettingsPage } from './settings';

export function Workspace() {
  const router = useRouter();
  const path = usePathname();
  const queryClient = useQueryClient();
  const [menu, setMenu] = useState(false);
  const [logoutError, setLogoutError] = useState('');
  const menuButton = useRef<HTMLButtonElement>(null);
  const navigation = useRef<HTMLElement>(null);
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api<{ user: User }>('/auth/me'),
    staleTime: 30_000,
  });
  const catalog = useQuery({
    queryKey: ['catalog'],
    queryFn: () => api<Catalog>('/catalog'),
    enabled: !!me.data && me.data.user.role !== 'SYSTEM_ADMIN',
  });
  useEffect(() => {
    if (me.error instanceof ApiError && me.error.status === 401) router.replace('/login');
  }, [me.error, router]);
  useEffect(() => {
    setMenu(false);
  }, [path]);
  useEffect(() => {
    if (!menu) return;
    const first = navigation.current?.querySelector<HTMLElement>('a, button');
    first?.focus();
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenu(false);
        menuButton.current?.focus();
      }
      if (event.key === 'Tab') {
        const targets = Array.from(navigation.current?.querySelectorAll<HTMLElement>('a, button') || []);
        const end = targets[targets.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          end?.focus();
        } else if (!event.shiftKey && document.activeElement === end) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [menu]);
  if (me.isPending || (me.error instanceof ApiError && me.error.status === 401))
    return (
      <div className="standalone">
        <Loading />
      </div>
    );
  if (me.error || !me.data)
    return (
      <div className="standalone">
        <ErrorNotice message={errorText(me.error)} retry={() => void me.refetch()} />
      </div>
    );
  const user = me.data.user;
  const clinical = user.role === 'CLINICAL_ADMIN';
  const admin = user.role === 'SYSTEM_ADMIN';
  const nav = [
    { href: '/app', label: 'Главная', icon: LayoutDashboard },
    ...(!admin
      ? [
          { href: '/app/new', label: 'Новый расчёт', icon: Plus },
          { href: '/app/history', label: 'История расчётов', icon: History },
        ]
      : []),
    ...(clinical ? [{ href: '/admin/content', label: 'Медицинский контент', icon: BookOpen }] : []),
    ...(admin ? [{ href: '/admin/users', label: 'Пользователи', icon: Users }] : []),
    { href: '/app/settings', label: 'Настройки', icon: Settings },
  ];
  async function logout() {
    try {
      await post('/auth/logout');
      queryClient.clear();
      router.replace('/login');
    } catch (e) {
      setLogoutError(errorText(e));
    }
  }
  let content: React.ReactNode;
  if (path === '/app/settings') content = <SettingsPage user={user} />;
  else if (path === '/admin/users') content = admin ? <UsersPage /> : <AccessDenied />;
  else if (path.startsWith('/admin/content/'))
    content = clinical ? <ContentDetail id={decodeURIComponent(path.split('/').pop()!)} /> : <AccessDenied />;
  else if (path === '/admin/content') content = clinical ? <ContentPage /> : <AccessDenied />;
  else if (admin && path !== '/app') content = <AccessDenied />;
  else if (path.startsWith('/app/cases/'))
    content = (
      <CaseEditor
        key={path}
        id={decodeURIComponent(path.split('/').pop()!)}
        catalog={catalog.data}
        user={user}
      />
    );
  else if (path.startsWith('/app/evaluations/'))
    content = (
      <SavedResult
        key={path}
        id={decodeURIComponent(path.split('/').pop()!)}
        catalog={catalog.data}
        user={user}
      />
    );
  else if (path === '/app/history') content = <HistoryPage catalog={catalog.data} user={user} />;
  else if (path === '/app/new')
    content = <NewCase catalog={catalog.data} loading={catalog.isPending} error={catalog.error} />;
  else if (path === '/app')
    content = admin ? (
      <>
        <PageTitle title="Доступ и роли" />
        <Link href="/admin/users" className="button primary">
          Открыть пользователей <ArrowRight size={17} />
        </Link>
      </>
    ) : (
      <>
        <NewCase catalog={catalog.data} loading={catalog.isPending} error={catalog.error} />
        <RecentCases catalog={catalog.data} />
      </>
    );
  else content = <Empty title="Страница не найдена" text="" href="/app" action="На главную" />;
  return (
    <AppearanceProvider key={user.id} userId={user.id}>
      <div className="workspace paper-workspace">
        <a className="skip-link" href="#main">
          Перейти к содержимому
        </a>
        <button
          ref={menuButton}
          className="button secondary paper-menu mobile-menu"
          aria-label={menu ? 'Закрыть навигацию' : 'Открыть меню'}
          aria-expanded={menu}
          aria-controls="workspace-navigation"
          onClick={() => setMenu(!menu)}
        >
          {menu ? <X size={20} /> : <Menu size={20} />}
          <span>Меню</span>
        </button>
        {menu && (
          <button
            className="menu-backdrop"
            aria-label="Закрыть меню"
            onClick={() => {
              setMenu(false);
              menuButton.current?.focus();
            }}
          />
        )}
        <aside ref={navigation} id="workspace-navigation" className={`sidebar ${menu ? 'open' : ''}`}>
          <nav aria-label="Главная навигация">
            {nav.map((item) => {
              const active =
                item.href === '/app'
                  ? path === '/app'
                  : path.startsWith(item.href) || (item.href === '/app/new' && path.includes('/cases/'));
              return (
                <Link
                  className={`nav-item ${active ? 'active' : ''}`}
                  href={item.href}
                  key={item.href}
                  aria-current={active ? 'page' : undefined}
                >
                  <item.icon size={18} />
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </nav>
          <div className="sidebar-user">
            <div>
              <strong>{user.login}</strong>
              <span>{roleLabel[user.role]}</span>
            </div>
            <button className="logout-button" onClick={logout} aria-label="Выйти">
              <LogOut size={18} />
            </button>
          </div>
        </aside>
        <div className="main-shell">
          <main id="main" className="main-content">
            {logoutError && <ErrorNotice message={logoutError} />}
            {content}
          </main>
        </div>
      </div>
    </AppearanceProvider>
  );
}
function AccessDenied() {
  return (
    <Empty
      title="Недостаточно прав"
      text="Этот раздел недоступен для вашей роли."
      href="/app"
      action="На главную"
    />
  );
}

export function NosologyCards({
  catalog,
  select,
  busy,
  selected,
}: {
  catalog?: Catalog;
  select: (code: string) => void;
  busy: boolean;
  selected?: string;
}) {
  return (
    <div className="nosology-grid" aria-label="Нозологии">
      {catalog?.nosologies.map((item, index) => (
        <button
          type="button"
          data-testid="nosology-card"
          className={`nosology-card ${selected === item.nosology_code ? 'selected' : ''}`}
          key={item.nosology_code}
          onClick={() => select(item.nosology_code)}
          disabled={busy}
          aria-pressed={selected === item.nosology_code}
        >
          <span className="nosology-number">{String(index + 1).padStart(2, '0')}</span>
          <span className="nosology-card-body">
            <strong>{item.name_ru}</strong>
          </span>
          {selected === item.nosology_code ? (
            <Check className="card-arrow" size={20} />
          ) : (
            <ArrowRight className="card-arrow" size={20} />
          )}
        </button>
      ))}
    </div>
  );
}
function NewCase({ catalog, loading, error }: { catalog?: Catalog; loading: boolean; error: unknown }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [search, setSearch] = useState('');
  const [selection, setSelection] = useState('');
  const selected = catalog?.nosologies.find((n) => n.nosology_code === selection) || catalog?.nosologies[0];
  const filtered = catalog && {
    ...catalog,
    nosologies: catalog.nosologies.filter((n) =>
      n.name_ru.toLocaleLowerCase('ru').includes(search.toLocaleLowerCase('ru').trim()),
    ),
  };
  async function start() {
    if (!selected || busy) return;
    setBusy(true);
    setProblem('');
    try {
      const draft = await post<CaseDraft>('/cases', { nosology_code: selected.nosology_code });
      queryClient.setQueryData(['case', draft.id], draft);
      await queryClient.invalidateQueries({ queryKey: ['cases'] });
      router.push(`/app/cases/${draft.id}`);
    } catch (e) {
      setProblem(errorText(e));
      setBusy(false);
    }
  }
  return (
    <>
      <PageTitle title="Клинический случай" description="Выберите нозологию" />
      {(problem || error) && <ErrorNotice message={problem || errorText(error)} />}
      <section className="nosology-sheet">
        <div className="search-input nosology-search">
          <Search size={18} />
          <input
            aria-label="Найти нозологию"
            placeholder="Найти нозологию"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {loading ? (
          <Loading />
        ) : (
          <NosologyCards
            catalog={filtered}
            selected={selected?.nosology_code}
            select={setSelection}
            busy={busy}
          />
        )}
        {!loading && catalog && !filtered?.nosologies.length && (
          <p className="empty-search" role="status">
            Нозология не найдена
          </p>
        )}
        <div className="nosology-actions">
          <span>
            Выбрано: <strong>{selected?.name_ru || '—'}</strong>
          </span>
          <button className="button primary" disabled={busy || !selected} onClick={() => void start()}>
            {busy ? 'Открываем…' : 'Заполнить данные'}
            <ArrowRight size={17} />
          </button>
        </div>
      </section>
    </>
  );
}
function RecentCases({ catalog }: { catalog?: Catalog }) {
  const cases = useQuery({ queryKey: ['cases'], queryFn: () => api<CaseDraft[]>('/cases') });
  const latest =
    cases.data
      ?.slice()
      .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))
      .slice(0, 3) || [];
  if (cases.error) return <ErrorNotice message={errorText(cases.error)} retry={() => void cases.refetch()} />;
  if (!latest.length) return null;
  return (
    <section className="recent-sheet">
      <div className="section-heading">
        <h2>Последние случаи</h2>
        <Link className="text-link" href="/app/history">
          История <ArrowRight size={15} />
        </Link>
      </div>
      <div className="recent-list">
        {latest.map((draft) => (
          <Link className="recent-case" href={`/app/cases/${draft.id}`} key={draft.id}>
            <FileClock size={18} />
            <div>
              <strong>
                {catalog?.nosologies.find((n) => n.nosology_code === draft.nosology_code)?.name_ru ||
                  draft.nosology_code}
              </strong>
              <span>{dateText(draft.updated_at)}</span>
            </div>
            <Badge>Черновик</Badge>
            <ChevronRight size={17} />
          </Link>
        ))}
      </div>
    </section>
  );
}
