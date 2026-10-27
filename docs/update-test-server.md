# Обновление «Клинического бланка» с сохранением истории и отзывов

Выполняйте команды из **существующего каталога проекта** на Linux-сервере. Инструкция относится к запущенному проекту `med-calc-demo` с прежним `.env.demo` и файлами `compose.yaml`, `compose.demo.yaml`. Если приложение запускалось с другим именем проекта (`-p` или `COMPOSE_PROJECT_NAME`), сохраните это имя во всех командах.

Обновление включает главную, одностраничные опросы, результаты, настройки и ролевые экраны в дизайне «Клинический бланк». Все три концепции сохранены в `docs/design/concepts/`. Схема БД, медицинские пакеты и конфигурация Compose не меняются; миграция или импорт истории для этого обновления не нужны.

Обновляются только контейнеры `api` и `web`; PostgreSQL и его volume не пересоздаются. `.env.demo` с паролем и `APP_ORIGIN` нужно оставить прежним. Не используйте `down -v`, `volume rm` или новый каталог/имя проекта вместо существующего окружения.

## 1. Получить код и собрать образ

```bash
git status --short
(umask 022; git pull --ff-only origin main)
docker compose --env-file .env.demo -f compose.yaml -f compose.demo.yaml ps
```

Если Git сообщает о конфликте локальных изменений, остановитесь и сохраните их отдельно. Не применяйте `reset --hard` или очистку каталога. Убедитесь, что команда Compose показывает именно существующие сервисы тестового сервера, в том числе PostgreSQL.

Ограничение `umask 077` применяйте только внутри блока резервного копирования. При получении кода используется `022`; кроме того, Dockerfile явно назначает владельцем скопированного кода пользователя `node`, от которого запускается приложение. Это позволяет читать исходники даже после сборки из каталога с правами файлов `600` и каталогов `700`.

Сохраните текущий образ приложения для отката и соберите новый. Работающие контейнеры на этом шаге продолжают обслуживать запросы:

```bash
(
  set -eu
  api_id=$(docker compose --env-file .env.demo -f compose.yaml -f compose.demo.yaml ps -q api)
  test -n "$api_id"
  old_image=$(docker inspect --format '{{.Image}}' "$api_id")
  rollback_tag="med-calc:before-ui-$(date +%Y%m%d-%H%M%S)"
  docker image tag "$old_image" "$rollback_tag"
  printf 'Образ для отката: %s\n' "$rollback_tag"
  docker compose --env-file .env.demo -f compose.yaml -f compose.demo.yaml build api web
)
```

Продолжайте только после успешной сборки; сохраните напечатанный тег старого образа.

## 2. Создать резервную копию и обновить приложение

Блок останавливается при ошибке резервного копирования и не запускает обновление. Дамп содержит базу целиком, включая расчёты, отзывы, пользователей и настройки; храните его с ограниченным доступом.

```bash
(
  set -eu
  backup="backups/before-ui-$(date +%Y%m%d-%H%M%S).dump"
  (
    umask 077
    mkdir -p backups
    docker compose --env-file .env.demo -f compose.yaml -f compose.demo.yaml exec -T postgres \
      pg_dump -U medcalc -d medcalc -Fc > "$backup"
    test -s "$backup"
    docker compose --env-file .env.demo -f compose.yaml -f compose.demo.yaml exec -T postgres \
      pg_restore --list < "$backup" > /dev/null
  )
  printf 'Резервная копия: %s\n' "$backup"
  docker compose --env-file .env.demo -f compose.yaml -f compose.demo.yaml exec -T postgres \
    psql -X -U medcalc -d medcalc -v ON_ERROR_STOP=1 \
    -c 'SELECT (SELECT count(*) FROM evaluations) AS evaluations, (SELECT count(*) FROM clinician_feedback) AS feedback;'
  docker compose --env-file .env.demo -f compose.yaml -f compose.demo.yaml \
    up -d --no-deps --no-build --wait api web
  docker compose --env-file .env.demo -f compose.yaml -f compose.demo.yaml exec -T postgres \
    psql -X -U medcalc -d medcalc -v ON_ERROR_STOP=1 \
    -c 'SELECT (SELECT count(*) FROM evaluations) AS evaluations, (SELECT count(*) FROM clinician_feedback) AS feedback;'
  docker compose --env-file .env.demo -f compose.yaml -f compose.demo.yaml ps
)
```

Проверка `pg_restore --list` подтверждает читаемость структуры дампа, но не заменяет испытание полного восстановления в отдельной базе. В этом обновлении восстановление или импорт данных не требуется.

## 3. Проверить результат

- `api` и `web` должны иметь состояние `healthy`; PostgreSQL должен использовать прежний volume.
- Количество расчётов и отзывов после обновления не должно уменьшиться. Если во время обновления врачи работают, оно может увеличиться.
- Войдите в приложение, откройте несколько прежних результатов в истории и проверьте их отзывы.
- В новом тестовом случае проверьте выбор нозологии, автосохранение, правку уже введённого поля на той же странице и отправку отзыва непосредственно у результата. Тестовый случай останется в истории.
- Проверьте настройки оформления и доступность пунктов меню для своей роли; роль через настройки оформления не меняется.
- После обновления перезагрузите страницу браузера, чтобы загрузился новый интерфейс.

## Если API перезапускается с EACCES при чтении app.ts

В таком случае процесс не может прочитать исходники внутри образа. PostgreSQL из-за этой ошибки не требуется пересоздавать или восстанавливать. После получения исправления выполните следующий блок в прежнем каталоге и с прежним Compose-проектом. Он проверяет чтение кода от непривилегированного пользователя до перезапуска приложения. Проверка запускается без зависимостей, не обращается к БД и не меняет её записи.

```bash
(
  set -eu
  dc() { docker compose --env-file .env.demo -f compose.yaml -f compose.demo.yaml "$@"; }
  counts() {
    dc exec -T postgres psql -X -U medcalc -d medcalc -v ON_ERROR_STOP=1 \
      -c 'SELECT (SELECT count(*) FROM evaluations) AS evaluations, (SELECT count(*) FROM clinician_feedback) AS feedback;'
  }
  test -n "$(dc ps -q postgres)"
  (umask 022; git pull --ff-only origin main)
  dc build api web
  dc run --rm --no-deps --entrypoint node api -e \
    'if(process.getuid()===0)throw Error("Ожидался непривилегированный пользователь"); require("node:fs").readFileSync("/app/apps/api/src/app.ts"); console.log("Исходники доступны, uid="+process.getuid())'
  counts
  dc up -d --no-deps --no-build --force-recreate --wait --wait-timeout 180 api web
  counts
  dc ps
)
```

Сохраните ранее созданные дамп и тег образа для отката. Сравните количество расчётов до и после запуска и откройте прежние результаты в интерфейсе. Если `api` всё ещё не становится `healthy`, используйте `docker compose --env-file .env.demo -f compose.yaml -f compose.demo.yaml logs --tail 100 api`; восстановление базы не является исправлением прав доступа к коду.

## Откат приложения при проблеме

Подставьте **сохранённый тег старого образа** из первого шага. Это откат кода; накопленные данные остаются в той же БД:

```bash
docker image tag med-calc:before-ui-ДАТА-ВРЕМЯ med-calc:0.1.0
docker compose --env-file .env.demo -f compose.yaml -f compose.demo.yaml \
  up -d --no-deps --no-build --force-recreate --wait api web
```

Дамп автоматически не восстанавливайте: это затрёт записи, появившиеся после его создания. Для диагностики используйте `docker compose --env-file .env.demo -f compose.yaml -f compose.demo.yaml logs --tail 100 api web`.
