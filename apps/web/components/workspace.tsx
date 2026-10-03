'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  ArrowRight,
  BookOpen,
  ChevronRight,
  CircleHelp,
  FileClock,
  FolderHeart,
  HeartPulse,
  History,
  LayoutDashboard,
  LogOut,
  Menu,
  Microscope,
  Plus,
  Search,
  Shield,
  Stethoscope,
  Users,
  Waves,
  Wind,
  X,
} from 'lucide-react';
import type { CaseDraft, EvaluationView } from '../../../packages/contracts/src/index';
import { api, ApiError, dateText, errorText, post, roleLabel, type Catalog, type User } from './api';
import { Badge, DemoNotice, Empty, ErrorNotice, Loading, PageTitle, PrivacyNote } from './ui';
import { CaseEditor } from './case-editor';
import { HistoryPage, SavedResult } from './results';
import { ContentDetail, ContentPage, UsersPage } from './admin';

export function Workspace({ demo = false }: { demo?: boolean }) {
  const router = useRouter();
  const path = usePathname();
  const queryClient = useQueryClient();
  const [menu, setMenu] = useState(false);
  const [logoutError, setLogoutError] = useState('');
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
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenu(false);
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [menu]);
  if (me.isPending || (me.error instanceof ApiError && me.error.status === 401))
    return (
      <div className="standalone">
        <Loading text="Открываем рабочее пространство…" />
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
    { href: '/app', label: 'Обзор', icon: LayoutDashboard },
    ...(!admin
      ? [
          { href: '/app/new', label: 'Новый расчёт', icon: Plus },
          { href: '/app/history', label: 'История расчётов', icon: History },
        ]
      : []),
    ...(clinical ? [{ href: '/admin/content', label: 'Медицинский контент', icon: BookOpen }] : []),
    ...(admin ? [{ href: '/admin/users', label: 'Пользователи', icon: Users }] : []),
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
  if (path === '/admin/users') content = admin ? <UsersPage /> : <AccessDenied />;
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
        <PageTitle
          eyebrow="СИСТЕМНОЕ АДМИНИСТРИРОВАНИЕ"
          title={`Здравствуйте, ${user.name || user.login}`}
          description="Управляйте доступом пользователей к рабочему пространству."
        />
        <section className="information-panel">
          <div className="information-icon">
            <Users size={27} />
          </div>
          <div>
            <h2>Доступ и роли</h2>
            <p>Создавайте учётные записи и назначайте права доступа в соответствии с рабочей ролью.</p>
            <Link href="/admin/users" className="button primary" style={{ marginTop: 18 }}>
              Открыть пользователей
              <ArrowRight size={16} />
            </Link>
          </div>
        </section>
      </>
    ) : (
      <Dashboard user={user} catalog={catalog.data} />
    );
  else
    content = (
      <Empty
        title="Страница не найдена"
        text="Вернитесь в рабочее пространство."
        href="/app"
        action="К обзору"
      />
    );
  return (
    <div className="workspace">
      <a className="skip-link" href="#main">
        Перейти к содержимому
      </a>
      {menu && <button className="menu-backdrop" aria-label="Закрыть меню" onClick={() => setMenu(false)} />}
      <aside id="workspace-navigation" className={`sidebar ${menu ? 'open' : ''}`}>
        <Link className="brand" href="/app">
          <span className="brand-mark">
            <Activity size={23} />
          </span>
          <span>
            клиника<span className="brand-dot">.</span>
          </span>
        </Link>
        <div className="sidebar-caption">РАБОЧЕЕ ПРОСТРАНСТВО</div>
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
                <item.icon size={19} />
                <span>{item.label}</span>
                {item.href === '/app/new' && <kbd>+</kbd>}
              </Link>
            );
          })}
        </nav>
        <div className="sidebar-note">
          <div className="sidebar-note-icon">
            <Shield size={21} />
          </div>
          <strong>Решение за врачом</strong>
          <p>Система объясняет путь от клинических данных к результату.</p>
          <span>
            Детерминированные правила
            <CheckDot />
          </span>
        </div>
        <div className="sidebar-user">
          <div className="avatar">{(user.name || user.login).slice(0, 1).toUpperCase()}</div>
          <div>
            <strong>{user.name || user.login}</strong>
            <span>{roleLabel[user.role]}</span>
          </div>
          <button className="logout-button" onClick={logout} aria-label="Выйти" title="Выйти">
            <LogOut size={17} />
          </button>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="topbar-left">
            <button
              className="icon-button mobile-menu"
              aria-label={menu ? 'Закрыть навигацию' : 'Открыть меню'}
              aria-expanded={menu}
              aria-controls="workspace-navigation"
              onClick={() => setMenu(!menu)}
            >
              {menu ? <X size={21} /> : <Menu size={21} />}
            </button>
            <span>Поддержка врачебных решений</span>
            <ChevronRight size={13} />
            <strong>{path.startsWith('/admin') ? 'Администрирование' : 'Антибактериальная терапия'}</strong>
          </div>
          <div className="topbar-right">
            <span className="environment-status">
              <i />
              Рабочее пространство
            </span>
            <button
              className="help-button"
              aria-label="О системе"
              onClick={() => document.getElementById('about-dialog')?.showPopover()}
            >
              <CircleHelp size={19} />
            </button>
          </div>
        </header>
        {(demo || catalog.data?.demo) && <DemoNotice />}
        <main id="main" className="main-content">
          {logoutError && <ErrorNotice message={logoutError} />}
          {content}
        </main>
        <footer className="page-footer">
          <span>Клиника · Поддержка принятия решений</span>
          <span>Версия 0.1.0 · Только для взрослых пациентов</span>
        </footer>
      </div>
      <div id="about-dialog" popover="auto" className="about-popover">
        <Shield size={28} />
        <h2>Объяснимая поддержка решений</h2>
        <p>
          Клинические правила исполняются на сервере. В каждом результате сохраняются версии контента, входные
          данные и трассировка.
        </p>
        <p>Система не устанавливает диагноз и не заменяет решение врача.</p>
        <button
          className="button secondary"
          onClick={() => document.getElementById('about-dialog')?.hidePopover()}
        >
          Понятно
        </button>
      </div>
    </div>
  );
}
function CheckDot() {
  return <span className="check-dot" />;
}
function AccessDenied() {
  return (
    <Empty
      title="Недостаточно прав"
      text="Этот раздел недоступен для вашей роли. Обратитесь к администратору организации."
      href="/app"
      action="К обзору"
    />
  );
}
const icons = [Wind, Waves, HeartPulse, Activity, Stethoscope, Microscope];
export function NosologyCards({
  catalog,
  select,
  busy,
}: {
  catalog?: Catalog;
  select: (code: string) => void;
  busy: boolean;
}) {
  return (
    <div className="nosology-grid">
      {catalog?.nosologies.map((item, index) => {
        const Icon = icons[index % icons.length];
        return (
          <button
            data-testid="nosology-card"
            className="nosology-card"
            key={item.nosology_code}
            onClick={() => select(item.nosology_code)}
            disabled={busy}
          >
            <span className={`nosology-icon color-${index % 3}`}>
              <Icon size={27} strokeWidth={1.65} />
            </span>
            <span className="nosology-card-body">
              <strong>{item.name_ru}</strong>
              <span>Клинический алгоритм</span>
            </span>
            <ArrowRight className="card-arrow" size={18} />
          </button>
        );
      })}
    </div>
  );
}
function NewCase({ catalog, loading, error }: { catalog?: Catalog; loading: boolean; error: unknown }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  async function select(code: string) {
    setBusy(true);
    setProblem('');
    try {
      const draft = await post<CaseDraft>('/cases', { nosology_code: code });
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
      <PageTitle
        eyebrow="НОВЫЙ КЛИНИЧЕСКИЙ СЛУЧАЙ"
        title="С чего начнём?"
        description="Выберите установленный диагноз. Мы последовательно запросим необходимые данные."
      />
      <div className="workflow-steps">
        <span className="current">
          <b>1</b>Нозология
        </span>
        <i />
        <span>
          <b>2</b>Клинические данные
        </span>
        <i />
        <span>
          <b>3</b>Результат
        </span>
      </div>
      {(problem || error) && <ErrorNotice message={problem || errorText(error)} />}
      {loading ? <Loading /> : <NosologyCards catalog={catalog} select={select} busy={busy} />}
      <PrivacyNote />
      <div className="information-panel">
        <div className="information-icon">
          <FolderHeart size={27} />
        </div>
        <div>
          <h3>Только вопросы, которые имеют значение</h3>
          <p>
            Следующий шаг определяется ответами и текущей версией правил. Неизвестные данные можно явно
            отметить — система покажет, каких сведений не хватает.
          </p>
        </div>
      </div>
    </>
  );
}
function Dashboard({ user, catalog }: { user: User; catalog?: Catalog }) {
  const cases = useQuery({ queryKey: ['cases'], queryFn: () => api<CaseDraft[]>('/cases') });
  const evaluations = useQuery({
    queryKey: ['evaluations'],
    queryFn: () => api<EvaluationView[]>('/evaluations'),
  });
  const latest =
    cases.data
      ?.slice()
      .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))
      .slice(0, 4) || [];
  return (
    <>
      <PageTitle
        eyebrow="ВАШЕ РАБОЧЕЕ ПРОСТРАНСТВО"
        title={`Здравствуйте, ${user.name || user.login}`}
        description="Всё для последовательного и обоснованного клинического решения."
        action={
          <span className="today-date">
            {new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', weekday: 'long' }).format(
              new Date(),
            )}
          </span>
        }
      />
      <section className="hero-panel">
        <div className="hero-copy">
          <span className="pill-light">
            <Stethoscope size={14} />
            Амбулаторная практика
          </span>
          <h2>
            От клинических данных
            <br />к понятному решению
          </h2>
          <p>
            Выберите нозологию, ответьте на вопросы
            <br className="desktop-only" /> и получите результат с объяснением.
          </p>
          <Link href="/app/new" className="button white">
            <Plus size={18} />
            Новый расчёт
            <ArrowRight size={17} />
          </Link>
        </div>
        <div className="hero-diagram" aria-hidden="true">
          <div className="diagram-grid" />
          <div className="diagram-card diagram-first">
            <span>
              <Stethoscope size={18} />
            </span>
            <div>
              <b>Клинические данные</b>
              <small>Последовательные вопросы</small>
            </div>
            <i />
          </div>
          <div className="diagram-connector" />
          <div className="diagram-card diagram-second">
            <span>
              <Activity size={18} />
            </span>
            <div>
              <b>Объяснимый результат</b>
              <small>Правила · безопасность · источники</small>
            </div>
            <Shield size={17} />
          </div>
          <div className="diagram-caption">Каждый шаг имеет значение</div>
        </div>
      </section>
      <div className="stats-row">
        <div className="stat-card">
          <span className="stat-icon teal">
            <Stethoscope size={21} />
          </span>
          <div>
            <strong>{catalog?.nosologies.length ?? '—'}</strong>
            <span>Клинических алгоритмов</span>
          </div>
          <Badge tone="success">v{catalog?.versions.ruleset || '0.1.0'}</Badge>
        </div>
        <div className="stat-card">
          <span className="stat-icon blue">
            <FileClock size={21} />
          </span>
          <div>
            <strong>{cases.data?.length ?? '—'}</strong>
            <span>Клинических случаев</span>
          </div>
        </div>
        <div className="stat-card">
          <span className="stat-icon violet">
            <History size={21} />
          </span>
          <div>
            <strong>{evaluations.data?.length ?? '—'}</strong>
            <span>Сохранённых расчётов</span>
          </div>
          <Link href="/app/history" aria-label="Перейти к истории">
            <ArrowRight size={18} />
          </Link>
        </div>
      </div>
      <div className="dashboard-columns">
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Последние случаи</h2>
              <p>Продолжите работу с сохранёнными данными</p>
            </div>
            <Link className="text-link" href="/app/history">
              Вся история
              <ArrowRight size={14} />
            </Link>
          </div>
          {cases.isPending ? (
            <Loading />
          ) : cases.error ? (
            <ErrorNotice message={errorText(cases.error)} />
          ) : !latest.length ? (
            <Empty
              title="Здесь появятся ваши случаи"
              text="Начните первый расчёт — данные сохранятся автоматически после каждого ответа."
              href="/app/new"
            />
          ) : (
            <div className="recent-list">
              {latest.map((draft) => (
                <Link className="recent-case" href={`/app/cases/${draft.id}`} key={draft.id}>
                  <span className="recent-icon">
                    <FolderHeart size={19} />
                  </span>
                  <div>
                    <strong>
                      {catalog?.nosologies.find((n) => n.nosology_code === draft.nosology_code)?.name_ru ||
                        draft.nosology_code}
                    </strong>
                    <span>
                      {dateText(draft.updated_at)} · {Object.keys(draft.facts).length} заполненных признаков
                    </span>
                  </div>
                  <Badge>Черновик</Badge>
                  <ChevronRight size={16} />
                </Link>
              ))}
            </div>
          )}
        </section>
        <section className="guide-panel">
          <span className="eyebrow">КАК ЭТО РАБОТАЕТ</span>
          <h2>Прозрачность на каждом шаге</h2>
          {[
            ['01', 'Укажите данные', 'Только признаки, нужные текущему алгоритму.'],
            ['02', 'Оцените результат', 'Режимы, ограничения и объяснение решения.'],
            ['03', 'Сохраните и сравните', 'История с версиями правил и обратной связью.'],
          ].map(([n, title, text]) => (
            <div className="guide-step" key={n}>
              <b>{n}</b>
              <div>
                <strong>{title}</strong>
                <p>{text}</p>
              </div>
            </div>
          ))}
          <div className="guide-foot">
            <Shield size={15} />
            Без прямых идентификаторов пациента
          </div>
        </section>
      </div>
    </>
  );
}
