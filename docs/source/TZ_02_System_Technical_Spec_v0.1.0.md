# Техническая спецификация системы CDSS антибактериальной терапии

**Версия спецификации:** 0.1.0  
**Статус архитектуры:** базовая спецификация для реализации  
**Технологический стек:** JavaScript/TypeScript  
**Отношение к `technical-spec.md`:** прежний документ используется как источник ранних требований только в той части, которая не конфликтует с текущим Rule Engine Contract, ruleset 0.1.0, моделью версионирования, Safety/Dose pipeline и согласованным жизненным циклом медицинского контента.

---

## 1. Область действия и нормативный статус

Документ определяет архитектуру всей системы, необходимую для реализации текущего этапа проекта. Он дополняет, но не заменяет **Rule Engine Contract v0.1.0**. Rule Engine Contract остается нормативным источником семантики `PatientCase`, AST-выражений, `RulePackage`, состояний вычисления и `DecisionTrace`.

Данная спецификация охватывает:

- browser UI;
- backend API;
- аутентификацию и авторизацию;
- хранение клинических случаев;
- хранение, валидацию и публикацию медицинского контента;
- интеграцию Rule Engine;
- Scheme Resolver;
- Safety Engine для противопоказаний и DDI;
- Dose Engine;
- Recommendation Composer;
- аудит, историю расчетов, feedback врача и экспорт;
- тестирование, развертывание и наблюдаемость.

Система является инструментом поддержки принятия решения. Она **не должна** позиционироваться как автономная система постановки диагноза или назначения терапии.

## 2. Архитектурные принципы

### 2.1. Modular monolith на первом этапе

Версия 0.1.0 **MUST** реализовываться как модульный монолит, а не как система микросервисов. `web` и `api` могут запускаться отдельными процессами/контейнерами, но доменные модули находятся в одном репозитории, используют одну основную PostgreSQL и выпускаются согласованно.

Причины выбора:

- клиническая семантика еще проходит валидацию;
- проще обеспечить транзакционность оценки, истории и аудита;
- ниже эксплуатационная сложность;
- доменные модули можно выделить в сервисы позднее без изменения контрактов.

### 2.2. Чистое клиническое ядро

Пакет Rule Engine **MUST** быть чистой TypeScript-библиотекой доменного уровня. Во время вычисления он **MUST NOT**:

- обращаться к PostgreSQL;
- выполнять HTTP-запросы;
- читать environment variables;
- изменять входной `PatientCase`;
- выполнять побочные эффекты;
- исполнять произвольный JavaScript из медицинского контента.

Концептуальный интерфейс:

```ts
EvaluationResult evaluate(
  CanonicalRulePackage rules,
  PatientCaseSnapshot patientCase
)
```

### 2.3. Frontend не содержит клинического алгоритма

Frontend может выполнять UI-валидацию, форматирование и управлять состоянием формы, но **MUST NOT** содержать вторую реализацию расчета баллов, ветвления клинического дерева, safety-фильтрации или выбора дозы.

### 2.4. Опубликованный медицинский контент неизменяем

Любое семантическое изменение опубликованного пакета приводит к новой версии. Исторические расчеты всегда сохраняют версии и хэши контента, с которым они были выполнены.

### 2.5. Структурированные данные первичны, текст вторичен

Схемы, лекарственные варианты, блокировки, warnings, дозы и trace должны существовать как структурированные объекты. Текст рекомендации генерируется в последней стадии и не является источником истины.

## 3. Технологическая база

Базовый стек на 26 сентября 2026 года:

| Слой | Выбранная технология | Требование |
|---|---|---|
| Runtime | Node.js 24 LTS | Точный patch фиксируется в репозитории; CI и production используют один major. |
| Язык | TypeScript, `strict` | Доменные и клинические пакеты компилируются в strict mode. |
| Monorepo | pnpm 12 workspaces | Один lockfile; внутренние зависимости через workspace protocol. |
| Frontend | Next.js App Router + React 19 | Только UI/BFF-функции; клинический расчет остается на backend/domain. |
| UI | Tailwind CSS + shadcn/ui либо эквивалентные доступные primitives | Компоненты хранятся в проекте и не зависят от закрытого design system. |
| Server state | TanStack Query | API data, mutations, cache invalidation. |
| Формы | React Hook Form + Zod | Типизированные формы и UI-валидация. |
| Backend | Fastify 5.x | REST/JSON API, schema-oriented routes, TypeScript. |
| БД | PostgreSQL | Основное надежное хранилище. |
| ORM | Prisma ORM 7.x | Для 0.1.0 фиксируется стабильная ветка v7; release candidate не используется в клиническом MVP. |
| App validation | Zod 4 | Runtime-валидация прикладных TypeScript-контрактов. |
| Rule package validation | AJV 8, Draft 2020-12 | Проверка JSON Schema из Rule Engine Contract v0.1.0. |
| Unit/integration tests | Vitest | Доменные и API-тесты. |
| Property tests | fast-check | Граничные и property-based проверки rule semantics. |
| E2E | Playwright | Desktop/tablet workflow и роли. |
| Logging | Pino | Структурированные серверные логи. |
| Telemetry | OpenTelemetry | Серверные traces/metrics; клинические payload по умолчанию не отправляются. |
| Local deployment | Docker Compose | `web`, `api`, `postgres`; reverse proxy при необходимости. |

Все зависимости фиксируются lockfile. Переход на новый major ключевого фреймворка требует отдельной проверки, поскольку воспроизводимость важнее автоматического следования за последней версией.

## 4. Структура репозитория

Рекомендуемая структура monorepo:

```text
repo/
├─ apps/
│  ├─ web/                       # Next.js UI врача и администратора
│  └─ api/                       # Fastify HTTP application
├─ packages/
│  ├─ contracts/                 # Shared request/response types + Zod
│  ├─ rule-engine/               # Чистый интерпретатор Rule Engine
│  ├─ rule-compiler/             # Authoring → canonical RulePackage
│  ├─ rule-validator/            # Structural + semantic validation
│  ├─ clinical-model/            # Facts, outcomes, common enums
│  ├─ therapy/                   # Scheme Resolver + treatment model
│  ├─ safety/                    # Contraindication/DDI evaluation
│  ├─ dosing/                    # Derived facts + dose rules
│  ├─ recommendation/            # Recommendation Composer
│  ├─ db/                        # Prisma, repositories, migrations
│  ├─ auth/                      # Sessions/RBAC
│  ├─ audit/                     # Audit contracts/helpers
│  ├─ export/                    # XLSX/CSV
│  └─ ui/                        # Shared UI primitives
├─ content/
│  ├─ clinical-rules/0.1.0/
│  ├─ drug-registry/0.1.0/
│  ├─ contraindications/0.1.0/
│  ├─ interactions/0.1.0/
│  └─ dosing/0.1.0/
├─ schemas/                      # Нормативные JSON Schema
├─ tests/
│  ├─ golden/
│  ├─ fixtures/
│  └─ e2e/
└─ pnpm-workspace.yaml
```

Пакеты `rule-engine`, `clinical-model`, `therapy`, `safety`, `dosing` не имеют права импортировать код из `apps/web` или `apps/api`.

## 5. Runtime-компоненты

```text
Browser
  │
  ▼
Next.js Web
  │  REST/JSON, same-origin /api
  ▼
Fastify API
  │
  ├─ Auth / RBAC
  ├─ Case Application Service
  ├─ Evaluation Orchestrator
  │    ├─ Clinical Rule Engine
  │    ├─ Scheme Resolver
  │    ├─ Safety Engine
  │    ├─ Dose Engine
  │    └─ Recommendation Composer
  ├─ Rule Package Administration
  ├─ Feedback
  ├─ Export
  └─ Audit
  │
  ▼
PostgreSQL
```

`Evaluation Orchestrator` — прикладной сервис координации. Он управляет вызовом доменных модулей и persistence, но не содержит медицинские правила выбора терапии.

## 6. Версионируемые пакеты медицинского контента

### 6.1. Типы пакетов

Система должна разделять следующие типы контента:

1. `clinical_ruleset` — decision graph всех шести нозологий;
2. `drug_registry` — стабильные целые `drug_id`, canonical names, aliases;
3. `therapy_catalog` — связь `scheme_id` с вариантами лечения и base regimen;
4. `contraindication_ruleset` — клиническое условие → safety action для препарата;
5. `interaction_ruleset` — кандидат + сопутствующий препарат → action/warning;
6. `dose_ruleset` — правила корректировки base regimen и required derived facts;
7. `form_catalog` — опциональный UI-слой метаданных для `fact_code`.

`clinical_ruleset`, drug registry и исходные treatment outputs уже существуют на уровне v0.1.0. Contraindication/DDI/dose content может оставаться `DRAFT`, пока не будет заполнен медицинской командой, но технические контракты этих модулей реализуются сейчас.

### 6.2. Общие metadata пакета

Каждый пакет должен иметь:

- `package_type`;
- semantic version;
- lifecycle status;
- created timestamp;
- SHA-256 canonical content;
- provenance/source metadata;
- compatibility metadata;
- validation report;
- approver metadata для `PUBLISHED`.

### 6.3. Lifecycle

```text
DRAFT → IN_REVIEW → VALIDATED → PUBLISHED → RETIRED
```

Для штатных расчетов врача активируются только `PUBLISHED` пакеты.

Опубликованный пакет изменить нельзя. Любая замена создает новую версию.

## 7. Интеграция Rule Engine Contract

### 7.1. Canonical RulePackage

Runtime принимает только canonical `RulePackage`, определенный Rule Engine Contract v0.1.0.

XLSX, mock-файлы и промежуточный authoring JSON напрямую не исполняются.

### 7.2. Запрет исполнения строковых условий

Строка вида:

```text
score(CB_MAJOR2) >= 1
```

может храниться для просмотра и debug, однако исполнимое условие представляется только типизированным AST.

Медицинский контент **MUST NOT** исполняться через `eval`, `new Function`, `vm`, dynamic import или эквивалентный механизм произвольного исполнения кода.

Внутреннее framework-level компилирование доверенных статических API-schema не является языком клинических правил и не должно принимать медицинский контент как JavaScript.

### 7.3. Состояния Rule Engine

Core engine возвращает:

- `COMPLETED`;
- `NEEDS_INPUT`;
- `FAILED`.

При `NEEDS_INPUT` результат содержит конкретные `fact_code`, необходимые для детерминированного продолжения.

### 7.4. Терминальные клинические состояния

Система сохраняет различие:

- `ABT_NOT_INDICATED`;
- `NO_APPLICABLE_DRUG`;
- `NOT_COVERED_BY_GUIDELINE`;
- `ESCALATE_HOSPITALIZATION`.

`NO_APPLICABLE_DRUG` обычно формируется после Safety Engine, а не внутри исходного нозологического графа.

## 8. Модель клинических фактов

### 8.1. Идентичность факта

Любой факт идентифицируется стабильным `fact_code`. Текст вопроса является presentation metadata и не используется как ключ.

### 8.2. Состояние факта

```ts
type FactState =
  | { state: 'KNOWN'; value: boolean | number | string }
  | { state: 'UNKNOWN' }
  | { state: 'NOT_ASSESSED' };
```

Отсутствующий факт не превращается автоматически в `false`.

### 8.3. Единицы измерения

Числовой факт либо хранит единицу в контракте значения, либо имеет одну неизменную unit в definition. Неоднозначное числовое значение без необходимой unit отклоняется.

### 8.4. Derived facts

Расчетные величины, например клиренс креатинина, хранятся отдельно от raw input:

```ts
interface DerivedFact {
  factCode: string;
  value: number;
  unit: string;
  calculatorId: string;
  calculatorVersion: string;
  inputFactCodes: string[];
}
```

## 9. Жизненный цикл ClinicalCase

### 9.1. Mutable draft

`ClinicalCase` — редактируемый черновик во время заполнения формы.

В 0.1.0 в нем нет прямых идентификаторов пациента.

### 9.2. Immutable evaluation snapshot

Каждый сохраняемый расчет создает immutable `PatientCaseSnapshot` со всеми фактами и состоянием сопутствующей терапии, использованными в конкретном вычислении.

Последующее редактирование case не меняет старые snapshots.

### 9.3. Сопутствующая терапия

Состояние списка лекарств:

```text
KNOWN_NONE
KNOWN_LIST
UNKNOWN
```

Распознанный элемент `KNOWN_LIST` ссылается на `drug_id`.

Нераспознанный free-text препарат может быть сохранен, но DDI-проверка обязана вернуть статус неполной проверки для этого элемента.

## 10. Evaluation Orchestrator

### 10.1. Pipeline

```text
1. Validate PatientCaseSnapshot
2. Load exact package versions
3. Compute available DerivedFacts
4. Execute Clinical Rule Engine
5. NEEDS_INPUT → return required facts
6. Clinical terminal → compose terminal result
7. Scheme Resolver → treatment candidates
8. Contraindication evaluation
9. DDI evaluation
10. Aggregate safety actions
11. No eligible candidate → NO_APPLICABLE_DRUG
12. Dose Engine / base-regimen fallback
13. Recommendation Composer
14. Persist immutable evaluation + trace + versions/hashes
15. Return result
```

### 10.2. Атомарность

Финальный persist evaluation должен транзакционно фиксировать snapshot, result metadata и ссылки на версии. Ошибка persistence не может возвращаться клиенту как успешный durable calculation.

### 10.3. Preview evaluation

API **SHOULD** поддерживать неперсистентный preview, позволяющий пошаговому UI получать необходимые факты и релевантные следующие вопросы.

Preview и final evaluation используют один и тот же доменный код.

## 11. Scheme Resolver и treatment model

### 11.1. Идентификатор схемы

Внутренний `scheme_id` стабилен и не зависит от исходной буквы `2Д`, `2Г` и других presentation labels.

Исходные обозначения сохраняются только как provenance.

### 11.2. TreatmentOption

```ts
interface TreatmentOption {
  optionId: string;
  schemeId: string;
  line: 'FIRST_LINE' | 'ALTERNATIVE_1' | 'ALTERNATIVE_2' | 'ALTERNATIVE_3';
  alternativeGroup?: string;
  drugId: number;
  baseRegimen: Regimen;
}
```

Формулировка «препарат A или препарат B» хранится как два структурированных варианта, а не как одна строка.

### 11.3. Regimen

Минимальная структура режима:

- dose amount;
- dose unit;
- route;
- frequency/interval;
- duration;
- optional loading dose;
- исходный source text для audit/migration.

## 12. Safety Engine

### 12.1. Унифицированные actions

```text
BLOCK
REVIEW_REQUIRED
WARN
ALLOW
```

Рекомендуемый порядок агрегации:

```text
BLOCK > REVIEW_REQUIRED > WARN > ALLOW
```

Агрегация определяет effective action, но отдельные findings не теряются.

### 12.2. ContraindicationRule

Запись содержит:

- `drug_id`;
- clinical criterion / AST;
- `action`;
- severity;
- message;
- source;
- validation status;
- optional nosology scope.

### 12.3. DrugInteractionRule

Authoring может использовать светофор:

| Категория | Default action |
|---|---|
| Red | `BLOCK` |
| Yellow | `WARN` |
| Green | `ALLOW` |
| Gray | `REVIEW_REQUIRED` |

Но поле `action` является нормативным. Цвет — presentation/provenance metadata.

### 12.4. Сохранение заблокированного кандидата

Препарат не исчезает из технического результата:

```ts
{
  drugId: 8,
  eligibility: 'BLOCKED',
  findings: [...]
}
```

UI врача может не показывать его в основном списке, но клинический фармаколог должен иметь возможность увидеть причину исключения.

### 12.5. Невалидированный safety content

Mock-записи имеют `enabled=false` и не влияют на clinical result. UI обязан различать:

- «валидированный справочник проверен, findings нет»;
- «справочник еще не валидирован/недоступен, проверка не выполнена полностью».

## 13. Dose Engine

### 13.1. Текущий scope

Модуль реализуется уже в 0.1.0, даже если активная медицинская логика первоначально использует только base regimen.

### 13.2. Binding

Минимальный ключ dose profile:

```text
nosology + drug_id
```

Следующая версия может привязать rule к конкретному `regimen_id`.

### 13.3. Missing adjustment data

Политика v0.1.0:

```text
USE_BASE_REGIMEN
```

Если валидированное правило корректировки существует, но данных для корректировки нет, возвращается base regimen, а причина фиксируется в trace.

Это правило не применяется к отсутствующим фактам, необходимым для выбора клинической схемы.

### 13.4. Calculators

Каждая формула получает стабильные `calculatorId` и `calculatorVersion`. В trace включаются исходные факты, рассчитанное значение, единицы и версия калькулятора.

## 14. Recommendation Composer

На вход получает структурированные результаты и формирует:

1. structured recommendation JSON;
2. краткий clinician-facing text;
3. расширенное explanation;
4. copy-to-clipboard representation.

Renderer не имеет права менять клиническое значение решения.

## 15. Decision Trace и объяснимость

`DecisionTrace` — first-class persisted artifact, а не обычный log.

Он включает по применимости:

- посещенные clinical nodes;
- использованные facts;
- score components;
- проверенные branches и selected edge;
- clinical outcome / scheme;
- treatment candidates;
- contraindication findings;
- DDI findings;
- dose/calculator results;
- recommendation composition;
- package versions и hashes.

UI explanation формируется на основании trace.

## 16. Application API

Prefix: `/api/v1`.

### 16.1. Authentication

```text
POST   /auth/login
POST   /auth/logout
GET    /auth/me
```

### 16.2. Clinical cases

```text
POST   /cases
GET    /cases/:caseId
PATCH  /cases/:caseId
DELETE /cases/:caseId          # optional soft delete собственного draft
```

### 16.3. Evaluation

```text
POST   /cases/:caseId/evaluate-preview
POST   /cases/:caseId/evaluations
GET    /evaluations/:evaluationId
GET    /evaluations/:evaluationId/trace
GET    /evaluations/:evaluationId/explanation
```

### 16.4. Drug search

```text
GET    /drugs/search?q=...
GET    /drugs/:drugId
```

Поиск **SHOULD** поддерживать normalized substring matching и aliases. Fuzzy matching допустим после deterministic alias matching.

### 16.5. Feedback

```text
POST   /evaluations/:evaluationId/feedback
GET    /evaluations/:evaluationId/feedback
```

### 16.6. Export

```text
POST   /exports/evaluations
GET    /exports/:exportId      # если export станет async
```

Небольшие выгрузки 0.1.0 могут генерироваться синхронно.

### 16.7. Clinical content administration

```text
GET    /admin/packages
POST   /admin/packages/import
POST   /admin/packages/:id/validate
POST   /admin/packages/:id/publish
POST   /admin/packages/:id/activate
GET    /admin/packages/:id/validation
```

Publish/activate требуют соответствующей роли и попадают в audit.

## 17. Требования к API contracts

- Все request/response bodies имеют явную schema.
- OpenAPI генерируется из доверенных application schemas.
- Domain errors имеют стабильные machine-readable codes.
- `NEEDS_INPUT` — нормальный domain result, не HTTP 500.
- Некорректный пользовательский ввод возвращает 4xx.
- Ошибка ruleset/configuration имеет отдельный код и operational log.
- Stack trace не возвращается клиенту в production.

## 18. Frontend architecture

### 18.1. Routes

```text
/login
/app
/app/new
/app/cases/:caseId
/app/evaluations/:evaluationId
/app/history
/admin/content
/admin/content/:packageId
/admin/users
```

### 18.2. Clinical workflow

UI использует progressive disclosure. Требуемые факты приходят из preview evaluation на сервере; frontend не реализует traversal графа.

Рекомендуемые области экрана:

- navigation/sidebar;
- main question/workflow area;
- optional context panel для score/explanation/warnings;
- persistent action footer: назад / продолжить / рассчитать.

### 18.3. Поведение форм

- Boolean facts показывают `Да`, `Нет`, `Неизвестно`.
- `NOT_ASSESSED` — внутреннее состояние до ответа пользователя.
- Numeric fields показывают unit.
- Диапазоны проверяются на client и server.
- Draft answers переживают reload страницы.
- После создания immutable evaluation результат read-only.

### 18.4. Экран результата

Визуально разделяются:

1. рекомендация;
2. warnings и incomplete checks;
3. rationale;
4. excluded options для разрешенных ролей;
5. sources и content versions;
6. clinician feedback.

Safety severity не должна кодироваться только цветом.

## 19. Persistence model

PostgreSQL — durable store.

### 19.1. Основные таблицы

- `users`;
- `roles`;
- `user_roles`;
- `sessions`;
- `clinical_cases`;
- `evaluations`;
- `clinician_feedback`;
- `content_packages`;
- `content_package_activations`;
- `drug_registry_entries`;
- `drug_aliases`;
- `audit_events`.

При необходимости таблицы могут быть декомпозированы без изменения доменных контрактов.

### 19.2. ClinicalCase

Хранит draft metadata и текущие form data. Прямые patient identifiers запрещены контрактом 0.1.0.

### 19.3. Evaluation

Рекомендуемые поля:

```text
id UUID PK
case_id UUID FK
created_by UUID FK
created_at timestamptz
nosology_code text
status text
patient_case_snapshot jsonb
clinical_outcome jsonb
therapy_result jsonb
safety_result jsonb
dose_result jsonb
recommendation jsonb
decision_trace jsonb
clinical_ruleset_version text
clinical_ruleset_hash text
drug_registry_version text
contraindications_version nullable text
interactions_version nullable text
dose_rules_version nullable text
```

Snapshot, результаты и hashes после успешного persist неизменяемы.

### 19.4. ContentPackage

```text
id UUID PK
package_type text
version text
status text
sha256 text
canonical_payload jsonb
validation_report jsonb
created_by UUID
created_at timestamptz
validated_at timestamptz nullable
published_at timestamptz nullable
```

Unique constraint: `(package_type, version)`.

## 20. Authentication и authorization

### 20.1. Роли

```text
DOCTOR
CLINICAL_PHARMACOLOGIST
CLINICAL_ADMIN
SYSTEM_ADMIN
```

Permissions проверяются только на server side.

### 20.2. Session model

Для 0.1.0 используются opaque server-side sessions:

- cryptographically random session ID;
- Secure HttpOnly cookie;
- `SameSite=Lax` либо строже;
- server-side session record;
- idle и absolute expiration;
- изменение ролей действует без ожидания истечения долгоживущего JWT.

SSO/OIDC может заменить local auth позднее без изменения domain API.

### 20.3. Пароли

Если используются локальные учетные записи, password хранится только как memory-hard hash, например Argon2id. Reversible/plaintext storage запрещен.

## 21. Конфиденциальность и минимизация данных

UI/API 0.1.0 не должны запрашивать или хранить:

- ФИО;
- полную дату рождения;
- номер полиса;
- адрес;
- телефон пациента;
- email пациента;
- иные прямые идентификаторы.

Возраст и необходимые клинические данные могут сохраняться в обезличенном snapshot.

Routine logs и telemetry не содержат raw clinical facts по умолчанию.

Использование системы с идентифицируемыми производственными пациентами требует отдельного юридического, security и regulatory review и не входит в эту спецификацию.

## 22. Audit

Audit events — append-only records для security и governance медицинского контента.

Минимально аудируются:

- login/logout и failed login;
- изменение пользователей/ролей;
- package import;
- validation;
- publication;
- activation/retirement;
- export generation;
- administrative access к детализированным evaluation data.

`DecisionTrace` не заменяет security audit, а security audit не заменяет clinical trace.

## 23. Logging и observability

Backend пишет structured logs:

- timestamp;
- level;
- request/correlation ID;
- route;
- duration;
- status code;
- application error code.

OpenTelemetry **SHOULD** использоваться для server traces и metrics. Browser telemetry — optional в 0.1.0.

В routine span/log не включаются `PatientCaseSnapshot`, полный список препаратов или `DecisionTrace`.

Рекомендуемые metrics:

- API latency;
- Rule Engine latency;
- evaluation status counts;
- ruleset validation failures;
- DB latency/error rate;
- active package versions.

## 24. Contract compiler/importer

Следующий компонент после утверждения этой спеки — compiler/importer.

Обязанности:

1. принять поддерживаемые authoring artifacts;
2. нормализовать stable IDs;
3. преобразовать display/string conditions в canonical AST;
4. проверить JSON Schema;
5. выполнить semantic graph validation;
6. применить согласованные ordinal subscheme mappings;
7. сформировать deterministic canonical JSON;
8. вычислить SHA-256;
9. сформировать validation report;
10. запретить publish при наличии errors.

Compiler не имеет права самостоятельно исправлять новые медицинские неоднозначности. Нормализация, не закрепленная versioned rule/decision, должна приводить к validation error и ручному review.

## 25. Semantic validator

Validator обязан обнаруживать:

- duplicate IDs;
- missing node references;
- неизвестные facts/scores/schemes/drugs;
- cycles;
- unreachable nodes;
- decision nodes без outgoing edges;
- несколько одновременно истинных взаимоисключающих branches;
- gaps в обязательном numeric/enum coverage, если declared total coverage;
- несовместимость type/operator;
- некорректные units;
- outgoing edge у terminal node;
- несовместимые package versions;
- включенные невалидированные medical rows в publishable package;
- попытку изменить content под уже опубликованной immutable version.

Недостаток provenance может быть warning. Errors блокируют publication.

## 26. Стратегия тестирования

### 26.1. Domain unit tests

Обязательны для:

- AST evaluator;
- boolean/enum/range operators;
- score calculation;
- UNKNOWN propagation;
- graph traversal;
- safety precedence;
- Scheme Resolver;
- Dose Engine fallback;
- Recommendation Composer.

### 26.2. Boundary tests

Для каждого numeric threshold автоматически проверяются значения ниже, равно и выше границы.

### 26.3. Property/exhaustive tests

Для небольших Boolean-графов генерируются комбинации и проверяется:

- отсутствие crash;
- отсутствие незаконных multiple transitions;
- deterministic result либо явный `NEEDS_INPUT`;
- корректность всех достижимых terminal paths.

### 26.4. Golden clinical cases

Golden cases предоставляются и утверждаются медицинской командой. Они запускаются в CI. Медицинский пакет не публикуется, если обязательные golden tests не проходят.

### 26.5. API integration tests

Используется disposable PostgreSQL. Проверяются transactions, RBAC, version binding, history, persistence и audit.

### 26.6. E2E

Playwright покрывает:

- login врача;
- happy path каждой нозологии;
- missing required fact;
- `ABT_NOT_INDICATED`;
- `NOT_COVERED_BY_GUIDELINE`;
- escalation;
- safety warning/block на валидированных test fixtures;
- copy result;
- feedback;
- history;
- admin validation/publish flow.

## 27. CI pipeline

На каждый pull request:

```text
frozen install
→ format/lint
→ typecheck
→ JSON Schema validation
→ semantic rule validation
→ unit tests
→ golden tests
→ integration tests
→ app build
→ Playwright smoke
```

Release pipeline дополнительно строит container images и запускает полный E2E suite.

Изменение только clinical content все равно запускает validator и golden suite.

## 28. Performance targets

Для объема данных v0.1.0:

- core Rule Engine **SHOULD** обычно работать заметно быстрее 100 ms в warm process;
- persisted evaluation API **SHOULD** иметь p95 < 500 ms при ожидаемой pilot load, без учета времени пользователя и bulk export;
- drug autocomplete **SHOULD** стремиться к p95 < 250 ms.

Нельзя улучшать performance ценой удаления trace/provenance.

## 29. Deployment

### 29.1. Local development

Docker Compose поднимает как минимум PostgreSQL. `web` и `api` допускается запускать через pnpm напрямую для fast reload.

### 29.2. Pilot deployment

Минимальный набор контейнеров:

```text
reverse-proxy (optional / infrastructure-specific)
web
api
postgres
```

Deployment обеспечивает:

- TLS termination;
- DB backups;
- secrets management;
- health endpoints;
- migration procedure;
- logs/metrics collection;
- закрытый network access к PostgreSQL.

Kubernetes не требуется для 0.1.0.

## 30. DB migrations и rollback

- Schema changes оформляются version-controlled migrations.
- Application rollback не должен удалять clinical history.
- Published content rows immutable.
- Content rollback выполняется activation предыдущей поддерживаемой `PUBLISHED` версии.
- Historical evaluations не пересчитываются автоматически.
- Destructive migration требует явного backup/recovery plan.

## 31. Export subsystem

Авторизованные клинические/исследовательские роли получают XLSX/CSV обезличенных evaluations.

Рекомендуемые колонки:

- evaluation ID;
- timestamp;
- nosology;
- fact values/states;
- scheme/terminal state;
- candidate и blocked drugs;
- warnings;
- dose status;
- package versions/hashes;
- clinician feedback.

Прямые patient identifiers в export schema 0.1.0 запрещены.

## 32. UI accessibility и browser support

UI **SHOULD** следовать практикам WCAG 2.1 AA для keyboard access, labels, focus и contrast, насколько это применимо к пилоту.

Поддерживаются актуальные maintained desktop Chromium, Firefox и Safari. Tablet layout обязателен. Native mobile app не требуется.

Clinical severity нельзя отображать только цветом; red/yellow/green/gray сопровождаются текстом/иконкой.

## 33. Error handling

Стабильные категории технических ошибок:

```text
INPUT_VALIDATION_ERROR
AUTH_REQUIRED
FORBIDDEN
CONTENT_PACKAGE_NOT_FOUND
CONTENT_PACKAGE_NOT_PUBLISHED
CONTENT_VALIDATION_ERROR
RULE_EVALUATION_ERROR
PERSISTENCE_ERROR
EXPORT_ERROR
```

Clinical terminal state не является technical error.

`NEEDS_INPUT` возвращается как domain payload с required facts.

## 34. Definition of Done версии 0.1.0

Система готова к контролируемому медицинскому пилоту, когда:

1. все шесть деревьев скомпилированы в canonical package;
2. runtime payload проходят Rule Engine Contract schemas;
3. semantic validator возвращает zero errors для published ruleset;
4. обязательные golden cases проходят;
5. frontend не дублирует clinical algorithm;
6. preview и final evaluation используют один engine;
7. versions/hashes контента фиксируются в каждой evaluation;
8. полный DecisionTrace сохраняется и доступен;
9. Scheme Resolver возвращает structured options;
10. Safety Engine и Dose Engine интегрированы модульно;
11. mock safety rules выключены;
12. history, feedback и XLSX/CSV export работают;
13. RBAC и audit enforced;
14. UI/API не принимают прямые patient identifiers;
15. CI, unit, integration и E2E tests проходят;
16. desktop/tablet workflow прошел usability review;
17. медицинская команда утвердила golden cases и package для pilot.

## 35. Явно вне scope 0.1.0

- ЕМИАС/МИС integration;
- OCR лабораторных документов;
- automatic EHR parsing;
- визуальный drag-and-drop rule editor;
- педиатрические правила;
- стационарные алгоритмы;
- native mobile app;
- electronic medical signature;
- generative AI для выбора терапии;
- microservices decomposition;
- Kubernetes;
- публикация medical content без human approval.

## 36. Сопоставление с прежним `technical-spec.md`

Старый документ сохраняет значение как ранний источник требований, однако текущая архитектура меняет ряд подходов.

### 36.1. Сохранено

- автономное web-приложение;
- шесть нозологий;
- server-side clinical calculation;
- authorization;
- обезличенная история;
- воспроизводимость по версии правил;
- desktop/tablet workflow;
- audit действий над правилами;
- ориентир порядка 500 ms для обычного расчета;
- формальный calculator UX, а не free-form chat.

### 36.2. Заменено

| Прежний подход | Базовый подход v0.1.0 |
|---|---|
| Runtime rules в YAML/JSON | Authoring-форматы компилируются в canonical AST-based RulePackage; исполняется только canonical package. |
| Clinical admin редактирует rule files | Admin импортирует, валидирует и публикует immutable packages; визуальный editor позднее. |
| DDI в основном как справка после получения схемы | Safety Engine проверяет кандидатов по структурированному списку сопутствующих препаратов до финальной рекомендации. |
| Четыре severity DDI как основной machine action | Явные `BLOCK/REVIEW_REQUIRED/WARN/ALLOW`; цвет/severity — presentation metadata. |
| Универсальный boolean yes/no | `KNOWN/UNKNOWN/NOT_ASSESSED`; отсутствие значения не равно false. |
| Режим терапии как готовая строка | Structured treatment/regimen первичен; текст формируется в конце. |
| Print/PDF как основной export | Обязательны copy result + XLSX/CSV; PDF optional/later. |
| Заранее выбран внешний справочник DDI | Текущая версия использует mock-contract до предоставления медицинской командой авторитетного валидированного dataset и provenance. |
| Клиническое дерево включает всю лекарственную логику | Clinical graph, therapy resolution, safety и dosing — отдельные модули. |

### 36.3. Не переносится

Любое старое требование, допускающее mutable published rules, использование невалидированного mock content, дублирование клинической логики во frontend, silent `missing → false` или прямое исполнение произвольных строк правил, считается отмененным текущим Rule Engine Contract и этой спецификацией.

## 37. Порядок реализации

1. bootstrap monorepo, DB, auth, CI;
2. shared contracts и persistence content packages;
3. compiler/importer + validator;
4. Rule Engine adapter и все шесть нозологий;
5. UI clinical case с preview/`NEEDS_INPUT`;
6. Scheme Resolver и structured regimen catalog;
7. drug registry search;
8. Safety Engine с disabled mock fixtures;
9. Dose Engine + base-regimen fallback;
10. Recommendation Composer + explanation;
11. persistence evaluation/trace;
12. feedback, history, export;
13. admin UI lifecycle пакетов;
14. golden cases и pilot validation.

## 38. Итоговое архитектурное решение

Версия 0.1.0 оптимизируется прежде всего под **аудируемость, скорость итераций и заменяемость медицинского контента**, а не под сложность распределенной инфраструктуры.

Ключевой инвариант:

```text
medical content = versioned data;
clinical execution = deterministic TypeScript code;
presentation = separate layer;
result = reproducible(snapshot + package versions + hashes).
```
