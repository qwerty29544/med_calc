import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

// Проверка создает обезличенный технический случай и пересоздает контейнеры.
// Запускать только для локального демонстрационного Compose-проекта med-calc.
const origin = process.env.BASE_URL ?? 'http://localhost:8080';
let cookie = '';
async function request(path, method = 'GET', body) {
  const response = await fetch(`${origin}/api/v1${path}`, {
    method,
    headers: {
      origin,
      ...(cookie ? { cookie } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000),
  });
  assert.ok(response.ok, `${method} ${path}: ${response.status}`);
  if (path === '/auth/login')
    cookie = response.headers
      .getSetCookie()
      .map((x) => x.split(';')[0])
      .join('; ');
  return response.json();
}
const health = await request('/health');
assert.equal(health.demo, true, 'Проверка разрешена только для демонстрации');
assert.equal(health.storage, 'postgresql');
await request('/auth/login', 'POST', { login: 'doctor', password: 'doctor-demo-2026' });
const draft = await request('/cases', 'POST', { nosology_code: 'ACUTE_BRONCHITIS' });
await request(`/cases/${draft.id}`, 'PATCH', {
  facts: {
    AGE_YEARS: { state: 'KNOWN', value: 35, unit: 'years' },
    AB_PURULENT_SPUTUM: { state: 'KNOWN', value: false, unit: null },
  },
});
const evaluation = await request(`/cases/${draft.id}/evaluations`, 'POST');
assert.equal(evaluation.status, 'COMPLETED');
assert.equal(evaluation.outcome.terminal_code, 'ABT_NOT_INDICATED');
console.log('Расчет сохранен в PostgreSQL. Пересоздание контейнеров с прежним volume...');
await new Promise((resolve, reject) => {
  const child = spawn(
    'docker',
    [
      'compose',
      '--env-file',
      '.env.docker',
      'up',
      '-d',
      '--force-recreate',
      '--no-build',
      '--wait',
      '--wait-timeout',
      '180',
    ],
    { stdio: 'inherit', windowsHide: true },
  );
  child.once('error', reject);
  child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`Compose: ${code}`))));
});
const restored = await request(`/evaluations/${evaluation.id}`);
assert.deepEqual(restored, evaluation, 'Неизменяемый результат должен сохраниться целиком');
assert.equal((await request('/health')).storage, 'postgresql');
console.log(
  'Проверено: web/API готовы, сессия и полный снимок расчета сохранились после пересоздания всех контейнеров.',
);
