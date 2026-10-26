import { expect, type BrowserContext, type Page } from '@playwright/test';

// Fresh browser contexts share only the authenticated test session, not page state.
// This keeps workflow tests below the real login rate limit (also tested in API tests).
const sessions = new Map<string, Awaited<ReturnType<BrowserContext['cookies']>>>();
export async function signIn(page: Page, login = 'doctor') {
  const origin = new URL(testBaseUrl()).origin;
  const key = `${origin}:${login}`;
  const cookies = sessions.get(key);
  if (cookies) {
    await page.context().addCookies(cookies);
    await page.goto('/app');
  } else {
    await page.goto('/login');
    await page.getByLabel('Логин', { exact: true }).fill(login);
    await page.getByLabel('Пароль', { exact: true }).fill(`${login}-demo-2026`);
    await page.getByRole('button', { name: 'Войти', exact: true }).click();
    await expect(page).toHaveURL(/\/app$/);
    sessions.set(key, await page.context().cookies());
  }
  await expect(page).toHaveURL(/\/app$/);
}
function testBaseUrl() {
  return process.env.BASE_URL || 'http://127.0.0.1:3000';
}
