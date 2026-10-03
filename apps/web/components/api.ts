import type { FactDefinition } from '../../../packages/contracts/src/index';
export type Role = 'DOCTOR' | 'CLINICAL_PHARMACOLOGIST' | 'CLINICAL_ADMIN' | 'SYSTEM_ADMIN';
export interface User {
  id: string;
  login: string;
  name: string;
  role: Role;
  active?: boolean;
}
export interface Catalog {
  nosologies: { nosology_code: string; name_ru: string }[];
  facts: FactDefinition[];
  demo: boolean;
  versions: Record<string, string>;
}
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    credentials: 'same-origin',
    ...init,
    headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new ApiError(
      response.status,
      error.message || 'Сервис временно недоступен. Повторите попытку.',
      error.code,
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
export const post = <T>(path: string, data?: unknown) =>
  api<T>(path, { method: 'POST', ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
export const patch = <T>(path: string, data: unknown) =>
  api<T>(path, { method: 'PATCH', body: JSON.stringify(data) });
export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : 'Произошла ошибка. Повторите попытку.';
export const roleLabel: Record<Role, string> = {
  DOCTOR: 'Врач',
  CLINICAL_PHARMACOLOGIST: 'Клинический фармаколог',
  CLINICAL_ADMIN: 'Клинический администратор',
  SYSTEM_ADMIN: 'Системный администратор',
};
export const dateText = (value?: string) =>
  value
    ? new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
    : '—';
