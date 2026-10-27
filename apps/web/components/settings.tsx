'use client';
import { useState } from 'react';
import { roleLabel, type User } from './api';
import { useAppearance, type Appearance } from './preferences';
import { PageTitle } from './ui';

export function SettingsPage({ user }: { user: User }) {
  const { appearance, update } = useAppearance();
  const [status, setStatus] = useState('');
  function change(patch: Partial<Appearance>) {
    update(patch);
    setStatus('Настройки применены');
  }
  return (
    <>
      <PageTitle title="Настройки" />
      <section className="settings-sheet" aria-label="Настройки интерфейса">
        <div className="setting-row">
          <label htmlFor="appearance-theme">Оформление</label>
          <select
            id="appearance-theme"
            value={appearance.theme}
            onChange={(e) => change({ theme: e.target.value as Appearance['theme'] })}
          >
            <option value="system">Как в системе</option>
            <option value="light">Светлое</option>
            <option value="dark">Тёмное</option>
          </select>
        </div>
        <div className="setting-row">
          <label htmlFor="appearance-density">Плотность</label>
          <select
            id="appearance-density"
            value={appearance.density}
            onChange={(e) => change({ density: e.target.value as Appearance['density'] })}
          >
            <option value="comfortable">Свободная</option>
            <option value="compact">Компактная</option>
          </select>
        </div>
        <div className="setting-row">
          <span>Анимация</span>
          <label className="checkbox-label" htmlFor="appearance-motion">
            <input
              id="appearance-motion"
              type="checkbox"
              checked={appearance.reduceMotion}
              onChange={(e) => change({ reduceMotion: e.target.checked })}
            />
            Уменьшить движение
          </label>
        </div>
        <dl className="settings-account">
          <div>
            <dt>Пользователь</dt>
            <dd>{user.login}</dd>
          </div>
          <div>
            <dt>Роль</dt>
            <dd>{roleLabel[user.role]}</dd>
          </div>
        </dl>
        <p className="settings-status" role="status">
          {status}
        </p>
      </section>
    </>
  );
}
