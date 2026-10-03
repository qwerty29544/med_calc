# Docker-окружение калькулятора

## Запуск на этом компьютере

Откройте `start-docker.cmd` в корне проекта. При необходимости скрипт запускает Docker Desktop и ждет его готовности. Первый запуск создает `.env.docker` со случайным паролем PostgreSQL. Файл исключен из Git и образа; сохраните его вместе с резервными копиями. Повторный запуск использует прежний пароль и volume.

Приложение: **http://localhost:8080**. Врач: `doctor` / `doctor-demo-2026`. Остальные демонстрационные роли перечислены в README. Это демонстрация DRAFT-контента; mock-правила выключены.

Запуск из PowerShell без открытия браузера:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/start-docker.ps1 -NoBrowser
```

После первого запуска можно пользоваться непосредственно Compose:

```powershell
docker compose --env-file .env.docker up --build -d --wait
docker compose --env-file .env.docker ps
docker compose --env-file .env.docker logs --tail 100
```

`postgres` проходит healthcheck, одноразовый `migrate` применяет миграции, затем запускаются `api` и `web`. Успешное завершение `migrate` с кодом 0 — нормальное состояние. У web и API также есть healthcheck. Web использует production-сборку Next.js. API работает в явно демонстрационном режиме с PostgreSQL; его `NODE_ENV=development` сохраняет запрет demo в целевом production-контуре.

Порт меняется через `WEB_PORT` в `.env.docker`, затем повторным запуском. И `localhost`, и `127.0.0.1` разрешены как origin. Опубликован только loopback-порт web; внешнего доступа к БД или API нет. Журналы ограничены тремя файлами по 10 МБ для каждого сервиса.

## Данные, остановка и автозапуск

Постоянный volume: `med-calc_postgres_data`, путь PostgreSQL 18 в контейнере: `/var/lib/postgresql`. Пересборка образа и пересоздание контейнеров сохраняют базу. Данные прежней файловой демонстрации `.data/local-demo.json` автоматически не переносятся: это отдельное хранилище.

```powershell
# Перезапуск с сохранением базы
docker compose --env-file .env.docker restart postgres api web
# Остановка контейнеров с сохранением базы
docker compose --env-file .env.docker stop
# Возобновление
docker compose --env-file .env.docker up -d --wait
# Удаление контейнеров и сети, volume остается
docker compose --env-file .env.docker down
```

`restart: unless-stopped` запускает сервисы после перезапуска Docker Engine. В Docker Desktop включите **Settings → General → Start Docker Desktop when you sign in**, если нужен запуск после входа в Windows. Явно остановленные сервисы следует запустить через `up -d`. Проверка готовности показывает состояние сервиса, но сама по себе не перезапускает зависший процесс; политика перезапуска применяется при завершении процесса.

Команда `down -v` удаляет базу; для обычной остановки ее не используйте. Если удалить `.env.docker` при сохраненном volume, новый пароль не совпадет с паролем существующей базы: восстановите прежний файл.

## Резервная копия

Команды ниже записывают бинарный архив внутри контейнера и копируют его как файл: это не зависит от кодировки перенаправления в Windows PowerShell.

```powershell
New-Item -ItemType Directory -Force backups
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
docker compose --env-file .env.docker exec -T postgres pg_dump -U medcalc -d medcalc -Fc -f /tmp/medcalc.dump
docker compose --env-file .env.docker cp postgres:/tmp/medcalc.dump "backups/medcalc-$stamp.dump"
```

Резервные копии исключены из Git. Проверку восстановления выполняйте в отдельной пустой базе. Запуск миграций не является резервным копированием.

## Тестовый сервер с демонстрационными аккаунтами

Для текущего этапа тестирования используйте **`compose.demo.yaml`**, без `compose.production.yaml`. На Linux-сервере после клонирования репозитория:

```bash
cp .env.demo.example .env.demo
chmod 600 .env.demo
nano .env.demo
```

Укажите в `.env.demo`:

```dotenv
POSTGRES_PASSWORD=СЛУЧАЙНАЯ_HEX_СТРОКА
WEB_PORT=8080
APP_ORIGIN=https://calc.example.ru
```

Для `POSTGRES_PASSWORD` используйте результат `openssl rand -hex 32`. `APP_ORIGIN` должен точно совпадать с адресом в браузере: схема, домен или IP и нестандартный порт, без пути и завершающего `/`. Для нескольких адресов укажите их через запятую. HTTPS reverse proxy на сервере направляет запросы на `127.0.0.1:8080`.

```bash
docker compose --env-file .env.demo \
  -f compose.yaml -f compose.demo.yaml \
  up --build -d --wait
```

На первом запуске в отдельной базе автоматически создаются учетные записи:

| Роль | Логин | Пароль |
|---|---|---|
| Врач | `doctor` | `doctor-demo-2026` |
| Клинический фармаколог | `pharmacist` | `pharmacist-demo-2026` |
| Клинический администратор | `clinical` | `clinical-demo-2026` |
| Системный администратор | `admin` | `admin-demo-2026` |

Web использует собранный Next.js, API — явный `DEMO_MODE=true`. DRAFT-расчеты и подсказки demo-входа доступны; клиническая публикация для тестирования не требуется. Данные сохраняются в `med-calc-demo_postgres_data`, сервисы автоматически перезапускаются вместе с Docker Engine. Файл `.env.demo` исключен из Git и Docker-образа, шаблон `.env.demo.example` входит в репозиторий.

Если ранее запущен production-проект на том же `WEB_PORT`, сначала остановите его своей прежней Compose-командой с `stop`, либо выберите другой порт и измените upstream reverse proxy. Demo-проект создает собственную базу; production-volume не удаляется и его содержимое автоматически не переносится. Для повторных запусков сохраняйте прежний `.env.demo` с паролем базы.

## Целевой контур с утвержденными пакетами

Используйте отдельный `.env.production`: `POSTGRES_PASSWORD` (случайная hex-строка), `WEB_PORT`, `APP_ORIGIN=https://ваш-домен`, `BOOTSTRAP_ADMIN_LOGIN`, `BOOTSTRAP_ADMIN_PASSWORD` (не менее 16 символов). Не используйте demo-пароли. Перед web необходим настроенный HTTPS reverse proxy, поскольку серверные session-cookie имеют Secure-флаг.

```powershell
docker compose --env-file .env.production -f compose.yaml -f compose.production.yaml up --build -d --wait
```

Проект `med-calc-production` использует отдельный volume `med-calc-production_postgres_data`. До публикации и активации совместимых клинического пакета и реестра расчеты закрыты; auth/admin доступны. Safety/dose-пакеты также проходят собственную валидацию и публикацию. Этот контур не был клинически утвержден или развернут во внешней сети.
