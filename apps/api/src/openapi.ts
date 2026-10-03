import swagger, { type StaticDocumentSpec } from '@fastify/swagger';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { draftPatch, goldenSchema } from './validation';
import { roles } from './security';
/** Только статические доверенные схемы HTTP. Клинический контент в OpenAPI не попадает. */
export async function registerOpenApi(app: FastifyInstance) {
  const paths: Record<string, Record<string, unknown>> = {};
  const schema = (s: z.ZodType) => z.toJSONSchema(s, { target: 'openapi-3.0', unrepresentable: 'any' });
  const route = (method: string, path: string, summary: string, input?: z.ZodType) => {
    (paths['/api/v1' + path] ??= {})[method] = {
      summary,
      security: [{ session: [] }],
      ...(path.includes('{id}')
        ? {
            parameters: [
              { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            ],
          }
        : {}),
      ...(input
        ? { requestBody: { required: true, content: { 'application/json': { schema: schema(input) } } } }
        : {}),
      responses: {
        '200': { description: 'Успешный ответ' },
        '201': { description: 'Ресурс сохранен' },
        '400': { description: 'Некорректный запрос' },
        '401': { description: 'Требуется сессия' },
        '403': { description: 'Недостаточно прав или неверный Origin' },
        '409': { description: 'Конфликт версии или жизненного цикла' },
      },
    };
  };
  route(
    'post',
    '/auth/login',
    'Вход с ограничением частоты',
    z.strictObject({ login: z.string().min(1).max(100), password: z.string().min(1).max(256) }),
  );
  route('get', '/auth/me', 'Текущий пользователь');
  route('post', '/auth/logout', 'Завершить сессию');
  route('get', '/catalog', 'Каталог вопросов');
  route('get', '/cases', 'Доступные случаи');
  route('post', '/cases', 'Создать черновик', z.strictObject({ nosology_code: z.string().min(1).max(80) }));
  route('get', '/cases/{id}', 'Черновик случая');
  route('patch', '/cases/{id}', 'Изменить черновик', draftPatch);
  for (const path of ['evaluate-preview', 'evaluations'])
    route(
      'post',
      `/cases/{id}/${path}`,
      path === 'evaluations' ? 'Сохранить неизменный расчет' : 'Предварительный расчет',
    );
  route('get', '/evaluations', 'История');
  for (const section of ['', '/trace', '/explanation'])
    route('get', '/evaluations/{id}' + section, 'Исторический результат');
  route('get', '/evaluations/{id}/feedback', 'Обратная связь');
  route(
    'post',
    '/evaluations/{id}/feedback',
    'Оставить обратную связь',
    z.strictObject({
      agreement: z.enum(['AGREE', 'DISAGREE']),
      used: z.boolean(),
      comment: z.string().max(2000),
    }),
  );
  route(
    'post',
    '/exports/evaluations',
    'Экспорт обезличенных расчетов',
    z.strictObject({ format: z.enum(['csv', 'xlsx']) }),
  );
  route('get', '/drugs/search', 'Поиск по активному реестру');
  route('get', '/drugs/{id}', 'Препарат по числовому drug_id');
  route('get', '/admin/users', 'Пользователи');
  route(
    'post',
    '/admin/users',
    'Создать пользователя',
    z.strictObject({
      login: z.string().min(3).max(80),
      name: z.string().min(1).max(100),
      password: z.string().min(12).max(256),
      role: z.enum(roles),
    }),
  );
  route(
    'patch',
    '/admin/users/{id}',
    'Изменить роль или доступ',
    z.strictObject({ role: z.enum(roles).optional(), active: z.boolean().optional() }),
  );
  route('get', '/admin/packages', 'Версии медицинских пакетов');
  route('post', '/admin/packages/import', 'Импорт в DRAFT', z.strictObject({ payload: z.unknown() }));
  route('post', '/admin/packages/{id}/validate', 'Проверка структуры и семантики');
  route('get', '/admin/packages/{id}/validation', 'Отчет проверки');
  route(
    'post',
    '/admin/packages/{id}/publish',
    'Медицинское утверждение и проверка golden cases',
    z.strictObject({
      approval_note: z.string().min(20).max(4000),
      golden_cases: z.array(goldenSchema).min(1).max(1000),
    }),
  );
  route('post', '/admin/packages/{id}/activate', 'Активация совместимой опубликованной версии');
  route(
    'post',
    '/admin/packages/activate-set',
    'Атомарная активация совместимого набора',
    z.strictObject({ package_ids: z.array(z.string().uuid()).min(1).max(5) }),
  );
  const document = {
    openapi: '3.0.3',
    info: {
      title: 'Медицинский калькулятор — API',
      version: '0.1.0',
      description:
        'Сессионная cookie. Изменяющие запросы требуют Origin из APP_ORIGIN. Медицинская публикация разрешена только CLINICAL_ADMIN. Схемы запросов сформированы из статических Zod-контрактов.',
    },
    paths,
    components: {
      securitySchemes: { session: { type: 'apiKey' as const, in: 'cookie' as const, name: 'med_session' } },
    },
  };
  await app.register(swagger, {
    mode: 'static',
    specification: { document: document as StaticDocumentSpec['document'] },
  });
  app.get('/api/v1/openapi.json', async () => app.swagger());
}
