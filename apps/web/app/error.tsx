'use client';
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main className="standalone">
      <h1>Не удалось открыть страницу</h1>
      <p>Сохранённые на сервере случаи остаются доступны. Попробуйте загрузить страницу ещё раз.</p>
      <button className="button primary" onClick={reset}>
        Повторить
      </button>
    </main>
  );
}
