'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Activity, ArrowRight, Check, Eye, EyeOff, LockKeyhole, ShieldCheck } from 'lucide-react';
import { errorText, post, type User } from './api';
import { ErrorNotice } from './ui';
const schema = z.object({
  login: z.string().trim().min(1, 'Введите логин'),
  password: z.string().min(1, 'Введите пароль'),
});
export function Login({ demo }: { demo: boolean }) {
  const router = useRouter();
  const client = useQueryClient();
  const [error, setError] = useState('');
  const [show, setShow] = useState(false);
  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema) });
  const submit = handleSubmit(async (data) => {
    setError('');
    try {
      const result = await post<{ user: User }>('/auth/login', data);
      client.clear();
      client.setQueryData(['me'], result);
      router.replace('/app');
    } catch (e) {
      setError(errorText(e));
    }
  });
  return (
    <main className="login-page">
      <section className="login-brand">
        <div className="login-message">
          <h1>Клинический расчёт</h1>
        </div>
      </section>
      <section className="login-form-side">
        <div className="login-form">
          <div className="login-lock">
            <LockKeyhole size={24} />
          </div>
          <h2>Войти в рабочее пространство</h2>
          <form onSubmit={submit} className="stack">
            {error && <ErrorNotice message={error} />}
            <div className="field">
              <label htmlFor="login">Логин</label>
              <input
                id="login"
                autoComplete="username"
                placeholder="Ваш логин"
                {...register('login')}
                aria-invalid={!!errors.login}
              />
              {errors.login && <span className="field-error">{errors.login.message}</span>}
            </div>
            <div className="field">
              <label htmlFor="password">Пароль</label>
              <div className="password-field">
                <input
                  id="password"
                  type={show ? 'text' : 'password'}
                  autoComplete="current-password"
                  placeholder="Введите пароль"
                  {...register('password')}
                  aria-invalid={!!errors.password}
                />
                <button
                  type="button"
                  className="icon-button"
                  aria-label={show ? 'Скрыть пароль' : 'Показать пароль'}
                  onClick={() => setShow(!show)}
                >
                  {show ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
              {errors.password && <span className="field-error">{errors.password.message}</span>}
            </div>
            <button type="submit" className="button primary full" disabled={isSubmitting}>
              {isSubmitting ? 'Входим…' : 'Войти'}
              <ArrowRight size={17} />
            </button>
          </form>
          {demo && (
            <details className="quick-login">
              <summary>Быстрый вход</summary>
              <div className="demo-accounts">
                {[
                  ['doctor', 'Врач'],
                  ['clinical', 'Клинический администратор'],
                  ['pharmacist', 'Фармаколог'],
                  ['admin', 'Системный администратор'],
                ].map(([login, label]) => (
                  <button
                    type="button"
                    key={login}
                    onClick={() => {
                      setValue('login', login);
                      setValue('password', `${login}-demo-2026`);
                    }}
                  >
                    <span>{label}</span>
                  </button>
                ))}
              </div>
            </details>
          )}
        </div>
      </section>
    </main>
  );
}
