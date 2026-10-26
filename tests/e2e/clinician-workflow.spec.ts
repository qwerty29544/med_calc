import { expect, test, type Page } from '@playwright/test';
import { signIn } from './auth';

async function start(page: Page, facts: Record<string, unknown> = {}) {
  await signIn(page, 'doctor');
  const headers = { origin: new URL(page.url()).origin };
  const created = await page.request.post('/api/v1/cases', {
    headers,
    data: { nosology_code: 'ACUTE_BRONCHITIS' },
  });
  expect(created.status()).toBe(201);
  const { id } = await created.json();
  if (Object.keys(facts).length) {
    const response = await page.request.patch(`/api/v1/cases/${id}`, { headers, data: { facts } });
    expect(response.status()).toBe(200);
  }
  await page.goto(`/app/cases/${id}`);
  await expect(page.getByTestId('case-ready')).toBeVisible();
  return id as string;
}

test('ответы сохраняются автоматически, отзыв доступен без ручного сохранения результата', async ({
  page,
}) => {
  const id = await start(page);
  await page.getByRole('spinbutton').fill('35');
  await page.getByRole('spinbutton').press('Tab');
  const sputum = page.getByTestId('fact-field').filter({ hasText: 'Кашель с гнойной мокротой' });
  await expect(sputum).toBeVisible();
  await sputum.getByRole('button', { name: 'Нет', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Обратная связь', exact: true })).toBeVisible();
  const data = await (await page.request.get(`/api/v1/cases/${id}`)).json();
  expect(data.facts.AGE_YEARS.value).toBe(35);
  expect(data.facts.AB_PURULENT_SPUTUM.value).toBe(false);
  await page.getByRole('button', { name: 'Согласен', exact: true }).click();
  await page.getByLabel('Комментарий').fill('Отзыв из предварительного результата');
  await page.getByRole('button', { name: 'Отправить обратную связь', exact: true }).click();
  await expect(page.getByText('Обратная связь сохранена', { exact: true })).toBeVisible();
  const evaluations = await (await page.request.get('/api/v1/evaluations')).json();
  const saved = evaluations.filter((e: { case_id: string }) => e.case_id === id);
  expect(saved).toHaveLength(1);
  const feedback = await (await page.request.get(`/api/v1/evaluations/${saved[0].id}/feedback`)).json();
  expect(feedback).toHaveLength(1);
  expect(feedback[0].comment).toBe('Отзыв из предварительного результата');
});

test('неизвестный ответ объясняет остановку и сохраняется после перезагрузки', async ({ page }) => {
  const id = await start(page);
  await page.getByTestId('fact-field').getByRole('button', { name: 'Неизвестно', exact: true }).click();
  await expect(page.getByTestId('missing-input-notice')).toContainText('Возраст');
  await expect
    .poll(async () => (await (await page.request.get(`/api/v1/cases/${id}`)).json()).facts.AGE_YEARS?.state)
    .toBe('UNKNOWN');
  await page.reload();
  await expect(page.getByTestId('missing-input-notice')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Сохранить результат', exact: true })).toBeDisabled();
});

test('связанные поля видны вместе, незаполненные факты не становятся отрицательными', async ({ page }) => {
  const id = await start(page, {
    AGE_YEARS: { state: 'KNOWN', value: 35, unit: 'years' },
    AB_PURULENT_SPUTUM: { state: 'KNOWN', value: true },
  });
  await expect(page.getByTestId('fact-field')).toHaveCount(5);
  const wbc = page.getByLabel('Лейкоциты, абсолютное число', { exact: true });
  await wbc.fill('11');
  await wbc.press('Tab');
  await expect
    .poll(async () => (await (await page.request.get(`/api/v1/cases/${id}`)).json()).facts.WBC?.value)
    .toBe(11);
  await expect(page.getByTestId('fact-field')).toHaveCount(5);
  const draft = await (await page.request.get(`/api/v1/cases/${id}`)).json();
  expect(draft.facts.AB_CLINICAL_INTOXICATION).toBeUndefined();
});

test('возврат и отмена изменения не меняют сохранённый ответ', async ({ page }) => {
  const id = await start(page, { AGE_YEARS: { state: 'KNOWN', value: 35, unit: 'years' } });
  await page.getByRole('button', { name: 'Назад', exact: true }).click();
  const age = page.getByRole('spinbutton');
  await expect(age).toHaveValue('35');
  await age.fill('50');
  await page.getByRole('button', { name: 'Отменить изменения', exact: true }).click();
  expect((await (await page.request.get(`/api/v1/cases/${id}`)).json()).facts.AGE_YEARS.value).toBe(35);
});

test('изменение во время сохранения не теряется, незавершённое число не отправляется', async ({ page }) => {
  const id = await start(page, {
    AGE_YEARS: { state: 'KNOWN', value: 35, unit: 'years' },
    AB_PURULENT_SPUTUM: { state: 'KNOWN', value: true },
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const first = new Promise<void>((resolve) => {
    started = resolve;
  });
  const patches: { facts?: Record<string, unknown> }[] = [];
  await page.route(`**/api/v1/cases/${id}`, async (route) => {
    if (route.request().method() !== 'PATCH') return route.continue();
    patches.push(route.request().postDataJSON());
    if (patches.length === 1) {
      started();
      await held;
    }
    await route.continue();
  });
  const wbc = page.getByLabel('Лейкоциты, абсолютное число', { exact: true });
  await wbc.fill('11');
  await wbc.press('Tab');
  await first;
  await wbc.fill('12');
  release();
  await expect
    .poll(async () => (await (await page.request.get(`/api/v1/cases/${id}`)).json()).facts.WBC?.value)
    .toBe(11);
  await expect(wbc).toHaveValue('12');
  expect(patches).toHaveLength(1);
  await wbc.press('Tab');
  await expect
    .poll(async () => (await (await page.request.get(`/api/v1/cases/${id}`)).json()).facts.WBC?.value)
    .toBe(12);
  expect(patches).toHaveLength(2);
  expect(Object.keys(patches[1].facts || {})).toEqual(['WBC']);
});

test('ошибка сети сохраняет ввод, после перезагрузки его можно отправить повторно', async ({ page }) => {
  const id = await start(page);
  await page.route(`**/api/v1/cases/${id}`, (route) =>
    route.request().method() === 'PATCH'
      ? route.fulfill({
          status: 503,
          json: { code: 'TEST_OUTAGE', message: 'Проверка временной недоступности' },
        })
      : route.continue(),
  );
  await page.getByRole('spinbutton').fill('42');
  await page.getByRole('spinbutton').press('Tab');
  await expect(page.getByRole('main').getByRole('alert')).toContainText('Проверка временной недоступности');
  await page.reload();
  await expect(page.getByRole('spinbutton')).toHaveValue('42');
  await page.unroute(`**/api/v1/cases/${id}`);
  await page.getByRole('button', { name: 'Сохранить ввод', exact: true }).click();
  await expect
    .poll(async () => (await (await page.request.get(`/api/v1/cases/${id}`)).json()).facts.AGE_YEARS?.value)
    .toBe(42);
  await expect(page.getByTestId('fact-field')).toContainText('Кашель с гнойной мокротой');
});

test('мобильный экран сохраняет доступ к группе полей и навигации без горизонтальной прокрутки', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await start(page, {
    AGE_YEARS: { state: 'KNOWN', value: 35, unit: 'years' },
    AB_PURULENT_SPUTUM: { state: 'KNOWN', value: true },
  });
  await expect(page.getByTestId('fact-field')).toHaveCount(5);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Назад', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Отменить изменения', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Отменить изменения', exact: true }).click();
  await page.screenshot({ path: `.data/ui-review/mobile-${test.info().project.name}.png`, fullPage: true });
});
