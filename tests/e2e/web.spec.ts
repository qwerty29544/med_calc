import { expect, test, type Page } from '@playwright/test';
import { signIn } from './auth';

async function answerNext(page: Page) {
  const question = page.locator('[data-testid="fact-field"][data-state="NOT_ASSESSED"]').first();
  await expect(question).toBeVisible();
  const saved = page.waitForResponse(
    (r) => /\/api\/v1\/cases\/[^/]+$/.test(new URL(r.url()).pathname) && r.request().method() === 'PATCH',
  );
  const no = question.getByRole('button', { name: 'Нет', exact: true });
  const number = question.getByRole('spinbutton');
  if (await no.count()) await no.click();
  else if (await number.count()) {
    await number.fill(/возраст/i.test(await question.innerText()) ? '35' : '0');
    await page.keyboard.press('Tab');
  } else if (await question.getByRole('combobox').count())
    await question.getByRole('combobox').selectOption({ index: 1 });
  else throw new Error(`Неожиданный тип вопроса: ${await question.innerText()}`);
  expect((await saved).status()).toBe(200);
  await expect(page.getByTestId('case-ready')).toBeVisible();
}

test('неавторизованный пользователь попадает на вход', async ({ page }) => {
  await page.goto('/app/new');
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole('heading', { name: 'Войти в рабочее пространство' })).toBeVisible();
});

test('врач создаёт случай, сохраняет неизвестный ответ и возвращается к черновику', async ({ page }) => {
  await signIn(page, 'doctor');
  if (test.info().project.name === 'desktop') {
    await expect(page.locator('.stat-card').first()).toContainText('6');
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      window.scrollTo(0, 0);
    });
    await page.screenshot({
      path: '.data/ui-review/dashboard-desktop.png',
      fullPage: true,
      animations: 'disabled',
    });
  }
  await page.getByRole('link', { name: 'Новый расчёт', exact: true }).first().click();
  await expect(page.getByTestId('nosology-card')).toHaveCount(6);
  await page.getByTestId('nosology-card').first().click();
  await expect(page).toHaveURL(/\/app\/cases\//);
  const caseUrl = page.url();
  await expect(page.getByTestId('question-card')).toBeVisible();
  await page.getByTestId('question-card').getByRole('button', { name: 'Неизвестно', exact: true }).click();
  await expect(page.getByTestId('case-ready')).toBeVisible();
  await page.reload();
  await expect(
    page.getByTestId('question-card').getByRole('button', { name: 'Неизвестно', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('Ответы сохранены')).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(caseUrl);
  await expect(
    page.getByTestId('question-card').getByRole('button', { name: 'Неизвестно', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Сохранить результат' })).toBeDisabled();
  await page.getByRole('button', { name: 'Указать препараты', exact: true }).click();
  await page.getByLabel('Найти препарат по названию').fill('амокси');
  await page
    .locator('.search-results button')
    .filter({ hasText: /амоксициллин/i })
    .first()
    .click();
  await expect(page.locator('.medication-tag')).toHaveCount(1);
  await expect(page.getByText('Ответы сохранены')).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Изменить сопутствующую терапию' }).click();
  await expect(page.locator('.medication-tag')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Указать препараты', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: 'Не принимает', exact: true }).click();
  await expect(page.getByText('Ответы сохранены')).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Изменить сопутствующую терапию' }).click();
  await expect(page.getByRole('button', { name: 'Не принимает', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.locator('.medication-tag')).toHaveCount(0);
});

test('результат остаётся неизменным, доступен в истории и принимает обратную связь', async ({ page }) => {
  await signIn(page, 'doctor');
  await page.goto('/app/new');
  // Выбираем реальную нозологию из каталога; ответы проходят серверное дерево.
  await page.getByTestId('nosology-card').filter({ hasText: 'Острый бронхит' }).click();
  for (let index = 0; index < 20; index++) {
    const saveResult = page.getByRole('button', { name: 'Сохранить результат', exact: true });
    await expect(page.getByTestId('case-ready')).toBeVisible();
    if (await saveResult.isEnabled()) break;
    await answerNext(page);
  }
  await page.getByRole('button', { name: 'Сохранить результат', exact: true }).click();
  await expect(page).toHaveURL(/\/app\/evaluations\//);
  const resultUrl = page.url();
  await expect(page.getByRole('heading', { name: 'Сохранённый результат', exact: true })).toBeVisible();
  await expect(page.getByText('Версии и контрольные суммы')).toBeVisible();
  await page.getByRole('button', { name: 'Согласен', exact: true }).click();
  await page.getByLabel('Рекомендация использована').check();
  await page.getByLabel('Комментарий').fill('Проверка рабочего процесса.');
  await page.getByRole('button', { name: 'Отправить обратную связь' }).click();
  await expect(page.getByText('Обратная связь сохранена')).toBeVisible();
  await page.getByRole('main').getByRole('link', { name: 'История расчётов', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Открыть результат' }).first()).toBeVisible();
  await page.goto(resultUrl);
  await expect(page.getByRole('heading', { name: 'Сохранённый результат', exact: true })).toBeVisible();
  const originalText = await page.locator('.recommendation-text').innerText();
  await page.getByRole('link', { name: 'Открыть исходный случай' }).click();
  await page.locator('.answers-list button').filter({ hasText: 'Возраст' }).click();
  await page.getByTestId('question-card').getByRole('spinbutton').fill('40');
  await page.getByRole('button', { name: 'Сохранить изменения', exact: true }).click();
  await expect(page.getByText('Ответы сохранены')).toBeVisible();
  await page.goto(resultUrl);
  await expect(page.locator('.recommendation-text')).toHaveText(originalText);
});

test('скорректированный режим отделён от исходной схемы и содержит нагрузочную дозу', async ({ page }) => {
  // В DRAFT отключены неутверждённые dose rules. Этот контрактный fixture
  // проверяет отображение серверного ADJUSTED без включения mock-медицины в продукт.
  await page.route('**/api/v1/auth/me', (route) =>
    route.fulfill({
      json: { user: { id: 'fixture-user', login: 'fixture', name: 'Тестовый врач', role: 'DOCTOR' } },
    }),
  );
  await page.route('**/api/v1/catalog', (route) =>
    route.fulfill({ json: { nosologies: [], facts: [], demo: true, versions: {} } }),
  );
  await page.route('**/api/v1/evaluations/adjusted-fixture', (route) =>
    route.fulfill({
      json: {
        id: 'adjusted-fixture',
        case_id: 'fixture',
        status: 'COMPLETED',
        missing_facts: [],
        questions: [],
        outcome: { type: 'TREATMENT_SCHEME', scheme_id: 'test' },
        title: 'Технический пример',
        warnings: [
          'Тестовый препарат: Предупреждение из серверного результата',
          'Отдельное критическое ограничение',
          'Демонстрационный расчет: медицинский пакет DRAFT не утвержден для клинического применения.',
        ],
        explanation: ['Тест отображения'],
        copy_text: 'Тестовый результат: 2 разf',
        trace: [],
        versions: { clinical_ruleset: 'test' },
        hashes: {},
        demo: true,
        safety_status: 'INCOMPLETE',
        options: [
          {
            option_id: 'test-option',
            drug_id: 1,
            drug_name: 'Тестовый препарат',
            line: 'FIRST_LINE',
            source_text: 'Исходная схема из источника',
            eligibility: 'ELIGIBLE',
            action: 'WARN',
            dose_status: 'ADJUSTED',
            findings: [
              {
                action: 'WARN',
                message: 'Предупреждение из серверного результата',
                source: 'Технический fixture',
              },
            ],
            regimen: {
              dose_amount: 123,
              dose_unit: 'тестовых единиц',
              route: 'Тестовый путь',
              frequency_per_day: 2,
              duration_days: 3,
              source_text: 'Тестовая коррекция',
              parse_status: 'STRUCTURED',
              loading_dose: { dose_amount: 246, dose_unit: 'тестовых единиц', duration_days: 1 },
            },
          },
        ],
      },
    }),
  );
  await page.goto('/app/evaluations/adjusted-fixture');
  await expect(page.getByText('123 тестовых единиц', { exact: true })).toBeVisible();
  await expect(page.getByText('Нагрузочная доза', { exact: true })).toBeVisible();
  await expect(page.getByText('246 тестовых единиц', { exact: true })).toBeVisible();
  await expect(page.getByText('Предупреждение из серверного результата', { exact: true })).toBeVisible();
  await expect(page.locator('.result-warnings li')).toHaveCount(1);
  await expect(page.locator('.result-warnings')).toContainText('Отдельное критическое ограничение');
  await expect(page.locator('.explanation-list')).not.toBeVisible();
  await expect(page.locator('.recommendation-text')).toHaveText('Тестовый результат: 2 раза');
  await expect(page.getByText('Исходная схема из источника', { exact: true })).not.toBeVisible();
  await page.getByText('Исходная схема из источника · для сравнения', { exact: true }).click();
  await expect(page.getByText('Исходная схема из источника', { exact: true })).toBeVisible();
});

test('системный администратор видит пользователей, но не публикацию медицинского контента', async ({
  page,
}) => {
  await signIn(page, 'admin');
  await page.getByRole('link', { name: 'Пользователи', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Пользователи', exact: true })).toBeVisible();
  await expect(page.getByText('doctor', { exact: true })).toBeVisible();
  await page.goto('/admin/content');
  await expect(page.getByText('Недостаточно прав')).toBeVisible();
});

test('каждая из шести нозологий проходит серверный путь и сохраняет текст результата', async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, 'doctor');
  for (const name of [
    'Хронический бронхит',
    'Острый бронхит',
    'Пневмония',
    'ХОБЛ, обострение',
    'Фарингит и тонзиллит',
    'Синусит',
  ]) {
    await page.goto('/app/new');
    await page.getByTestId('nosology-card').filter({ hasText: name }).click();
    const finish = page.getByRole('button', { name: 'Сохранить результат', exact: true });
    for (let index = 0; index < 35; index++) {
      await expect(page.getByTestId('case-ready')).toBeVisible();
      if (await finish.isEnabled()) break;
      const question = page.getByTestId('question-card');
      await expect(question).toBeVisible();
      if (test.info().project.name === 'tablet' && name === 'Острый бронхит' && index === 1) {
        await page.evaluate(() => {
          if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
          window.scrollTo(0, 0);
        });
        await page.screenshot({
          path: '.data/ui-review/case-tablet.png',
          fullPage: false,
          animations: 'disabled',
        });
      }
      await answerNext(page);
    }
    await expect(finish).toBeEnabled();
    await finish.click();
    await expect(page).toHaveURL(/\/app\/evaluations\//);
    await expect(page.getByRole('heading', { name: 'Сохранённый результат', exact: true })).toBeVisible();
    await expect(page.locator('.recommendation-text')).not.toBeEmpty();
    await expect(page.locator('.recommendation-text')).toContainText('0.1.0');
    await page.getByRole('button', { name: 'Копировать', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Скопировано', exact: true })).toBeVisible();
  }
});

test('клинический администратор видит отчёт проверки и не публикует неподтверждённый пакет', async ({
  page,
}) => {
  await signIn(page, 'clinical');
  await page.getByRole('link', { name: 'Медицинский контент', exact: true }).click();
  await page.getByLabel('Содержимое пакета').fill('{');
  await page.getByRole('button', { name: 'Импортировать JSON', exact: true }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('Некорректный JSON');
  await page.locator('.package-row').first().click();
  await page.getByRole('button', { name: 'Запустить валидацию', exact: true }).click();
  await expect(page.getByText('Проверка выполнена. Ознакомьтесь с отчётом.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Отчёт валидации', exact: true })).toBeVisible();
  await expect(page.getByLabel('Комментарий клинического утверждения')).toBeVisible();
  await expect(page.getByLabel('Утверждённые эталонные случаи · JSON')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Активировать версию', exact: true })).toHaveCount(0);
});

test('запоздалый preview не заменяет вопрос после сохранения новых данных', async ({ page }) => {
  await page.route('**/api/v1/auth/me', (route) =>
    route.fulfill({
      json: { user: { id: 'race-user', login: 'fixture', name: 'Тестовый врач', role: 'DOCTOR' } },
    }),
  );
  await page.route('**/api/v1/catalog', (route) =>
    route.fulfill({
      json: {
        nosologies: [{ nosology_code: 'TEST', name_ru: 'Технический сценарий' }],
        facts: [],
        demo: true,
        versions: {},
      },
    }),
  );
  let revision = 0;
  await page.route('**/api/v1/cases/race-fixture', async (route) => {
    if (route.request().method() === 'PATCH') revision++;
    await route.fulfill({
      json: {
        id: 'race-fixture',
        nosology_code: 'TEST',
        facts: {},
        medications: { state: revision ? 'KNOWN_NONE' : 'UNKNOWN', drug_ids: [], unrecognized: [] },
        updated_at: `2026-10-02T00:00:0${revision}Z`,
      },
    });
  });
  let releaseOld!: () => void;
  let signalStarted!: () => void;
  let signalSettled!: () => void;
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  const held = new Promise<void>((resolve) => {
    releaseOld = resolve;
  });
  const settled = new Promise<void>((resolve) => {
    signalSettled = resolve;
  });
  let previewCount = 0;
  await page.route('**/api/v1/cases/race-fixture/evaluate-preview', async (route) => {
    const old = previewCount++ === 0;
    if (old) {
      signalStarted();
      await held;
    }
    const label = old ? 'Устаревший вопрос' : 'Актуальный вопрос';
    try {
      await route.fulfill({
        json: {
          case_id: 'race-fixture',
          status: 'NEEDS_INPUT',
          missing_facts: ['TEST_FACT'],
          questions: [
            {
              fact_code: 'TEST_FACT',
              label_ru: label,
              data_type: 'BOOLEAN',
              unit: null,
              unknown_allowed: true,
              unknown_policy: 'NEEDS_INPUT',
            },
          ],
          outcome: null,
          title: label,
          options: [],
          warnings: [],
          explanation: [],
          copy_text: '',
          trace: [],
          versions: {},
          hashes: {},
          demo: true,
          safety_status: 'INCOMPLETE',
        },
      });
    } finally {
      if (old) signalSettled();
    }
  });
  await page.goto('/app/cases/race-fixture');
  await started;
  await page.getByRole('button', { name: 'Не принимает', exact: true }).click();
  await expect(
    page.getByTestId('question-card').getByRole('heading', { name: 'Актуальный вопрос', exact: true }),
  ).toBeVisible();
  releaseOld();
  await settled;
  await expect(
    page.getByTestId('question-card').getByRole('heading', { name: 'Актуальный вопрос', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Устаревший вопрос', exact: true })).toHaveCount(0);
});

test('планшетное меню скрыто от клавиатуры и закрывается клавишей Escape', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.route('**/api/v1/auth/me', (route) =>
    route.fulfill({
      json: {
        user: { id: 'admin-fixture', login: 'fixture', name: 'Тестовый администратор', role: 'SYSTEM_ADMIN' },
      },
    }),
  );
  await page.goto('/app');
  await expect(
    page.getByRole('heading', { name: 'Здравствуйте, Тестовый администратор', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Пользователи', exact: true })).not.toBeVisible();
  await page.getByRole('button', { name: 'Открыть меню', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Закрыть навигацию', exact: true })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await expect(page.getByRole('link', { name: 'Пользователи', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('link', { name: 'Пользователи', exact: true })).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Открыть меню', exact: true })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
});
