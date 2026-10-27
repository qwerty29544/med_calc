import { expect, test } from '@playwright/test';
import { signIn } from './auth';

test('поиск и выбор нозологии начинают расчёт без лишних шагов', async ({ page }) => {
  await signIn(page);
  await page.getByLabel('Найти нозологию', { exact: true }).fill('острый');
  await expect(page.getByTestId('nosology-card')).toHaveCount(1);
  await page.getByTestId('nosology-card').click();
  await page.getByRole('button', { name: 'Заполнить данные', exact: true }).click();
  await expect(page).toHaveURL(/\/app\/cases\//);
  await expect(page.getByLabel('Возраст пациента', { exact: true })).toBeVisible();
  await expect(page.locator('.topbar, .demo-notice, .brand')).toHaveCount(0);
});

test('заполненные поля остаются на странице и доступны для правки', async ({ page }) => {
  await signIn(page);
  const response = await page.request.post('/api/v1/cases', {
    headers: { origin: new URL(page.url()).origin },
    data: { nosology_code: 'ACUTE_BRONCHITIS' },
  });
  const { id } = await response.json();
  await page.goto(`/app/cases/${id}`);
  const age = page.getByLabel('Возраст пациента', { exact: true });
  await age.fill('35');
  await age.press('Tab');
  await expect(page.getByRole('heading', { name: /Кашель с гнойной мокротой/ })).toBeVisible();
  await expect(age).toBeVisible();
  await expect(age).toHaveValue('35');
  await age.fill('42');
  await age.press('Tab');
  await expect
    .poll(async () => (await (await page.request.get(`/api/v1/cases/${id}`)).json()).facts.AGE_YEARS.value)
    .toBe(42);
  await page.reload();
  await expect(age).toHaveValue('42');
});

test('неверное поле показывает доступную ошибку и сохраняет исходный расчёт', async ({ page }) => {
  await signIn(page);
  const response = await page.request.post('/api/v1/cases', {
    headers: { origin: new URL(page.url()).origin },
    data: { nosology_code: 'ACUTE_BRONCHITIS' },
  });
  const { id } = await response.json();
  await page.goto(`/app/cases/${id}`);
  const age = page.getByLabel('Возраст пациента', { exact: true });
  await age.fill('-1');
  await age.press('Tab');
  await expect(age).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('.field-error[role="alert"]')).toBeVisible();
  await expect(page.locator('.field-error[role="alert"]')).toContainText('не меньше');
  await page.getByRole('button', { name: 'Сохранить ввод', exact: true }).click();
  await expect(age).toBeFocused({ timeout: 1500 });
  const draft = await (await page.request.get(`/api/v1/cases/${id}`)).json();
  expect(draft.facts.AGE_YEARS).toBeUndefined();
  await age.fill('35');
  await age.press('Tab');
  await expect(age).not.toHaveAttribute('aria-invalid', 'true');
});

test('настройки сохраняются, работают без движения и не меняют роль', async ({ page }) => {
  await signIn(page);
  await page.getByRole('link', { name: 'Настройки', exact: true }).click();
  await page.getByLabel('Оформление', { exact: true }).selectOption('dark');
  await page.getByLabel('Плотность', { exact: true }).selectOption('compact');
  await page.getByLabel('Уменьшить движение', { exact: true }).check();
  await page.reload();
  await expect(page.getByLabel('Оформление', { exact: true })).toHaveValue('dark');
  await expect(page.getByLabel('Плотность', { exact: true })).toHaveValue('compact');
  await expect(page.getByLabel('Уменьшить движение', { exact: true })).toBeChecked();
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduced');
  expect((await (await page.request.get('/api/v1/auth/me')).json()).user.role).toBe('DOCTOR');
  await page.goto('/admin/users');
  await expect(page.getByText('Недостаточно прав', { exact: true })).toBeVisible();
});
