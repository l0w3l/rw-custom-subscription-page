# Публикация Docker-образа

Образ: `1owe1/rw-custom-subscription-page`.
Исходники: https://github.com/l0w3l/rw-custom-subscription-page.

## Настройка один раз

1. В Docker Hub создайте репозиторий `rw-custom-subscription-page` в namespace `1owe1`.
2. Создайте Docker Hub Personal Access Token с правами Read/Write.
3. В GitHub-репозитории откройте Settings → Secrets and variables → Actions и добавьте repository secrets:
   - `DOCKERHUB_USERNAME`: `1owe1`;
   - `DOCKERHUB_TOKEN`: созданный токен.
4. Включите GitHub Actions для форка, если они отключены.

Токены не добавляются в исходники или `.env` приложения. Secrets для Telegram и GHCR не нужны.

## Выпуск версии

Сначала закоммитьте и отправьте изменения в GitHub. Затем создайте тег на нужном коммите:

```sh
git tag v1.0.0
git push origin v1.0.0
```

Workflow `Build and publish Docker image` проверяет backend, собирает frontend и backend внутри Docker и публикует платформы `linux/amd64` и `linux/arm64`. Для релиза создаются теги `v1.0.0`, `latest` и `sha-<полный SHA коммита>`.

Поддержаны стабильные теги строго вида `vX.Y.Z`. Каждый опубликованный релиз обновляет `latest`, поэтому не запускайте старый релиз повторно, если не хотите переместить этот тег назад.

Push в ветку `dev` публикует `dev` и тег коммита, не меняя `latest`. Pull requests только проверяются и собираются: вход в Docker Hub и публикация не выполняются. Ручной запуск на обычной ветке тоже только проверяет сборку; ручной запуск на `dev` или теге релиза публикует соответствующий образ. Публикация разрешена только из `l0w3l/rw-custom-subscription-page`.

## Локальная проверка

```sh
docker build -t 1owe1/rw-custom-subscription-page:local .
```

Предварительная сборка `frontend/dist` не требуется. `.dockerignore` исключает локальные зависимости, результаты сборки и файлы `.env`.

## Запуск на сервере

Создайте `.env` по `.env.sample`, задайте URL/API-токен панели и включите объединение:

```dotenv
CUSTOM_SUB_PREFIX=sub
TELEGRAM_SUBSCRIPTION_MERGE_ENABLED=true
IMAGE_TAG=v1.0.0
```

Production Compose использует существующую сеть `remnawave-network`, общую с панелью.

```sh
docker compose -f docker-compose-prod.yml pull
docker compose -f docker-compose-prod.yml up -d
```

Если `IMAGE_TAG` не задан, используется `latest`. Для отката задайте предыдущий опубликованный тег и повторите команды.

Docker Hub не заменяет конфигурацию панели: API-токен и параметры Remnawave передаются контейнеру во время запуска. Приватный Docker Hub репозиторий требует `docker login` на сервере перед pull.

Документация Docker: [Personal Access Tokens](https://docs.docker.com/security/access-tokens/personal-access-tokens/), [Multi-platform GitHub Actions](https://docs.docker.com/build/ci/github-actions/multi-platform/).
