import Link from 'next/link';
export default function NotFound() {
  return (
    <main className="standalone">
      <h1>Страница не найдена</h1>
      <p>Адрес изменился или страница недоступна.</p>
      <Link className="button primary" href="/app">
        В рабочее пространство
      </Link>
    </main>
  );
}
