# Paradox MMO

2D MMORPG в браузере для игры с друзьями. Форк [Kaetram-Open](https://github.com/Kaetram/Kaetram-Open) с единым Railway-деплоем: сервер (uWebSockets + Node) и клиент (Astro SSG) упакованы в один Docker-образ.

## Быстрый старт на Railway

### Шаг 1. Новый проект из репозитория

1. Откройте [railway.com/new](https://railway.com/new) → **"Deploy from GitHub repo"**
2. Выберите `21deni19zzz-dotcom/paradox-mmo`
3. Railway автоматически возьмёт `Dockerfile` и `railway.toml` из корня

### Шаг 2. Получить публичный домен

В Railway сервис → **Settings → Networking → Generate Domain**.
Получится что-то вроде `paradox-mmo-production.up.railway.app`.

### Шаг 3. Build Args (критично!)

Клиент — Astro SSG, URL игрового сервера зашивается в HTML **на этапе сборки**.

Service → **Settings → Build → Build Arguments**, добавить:

| Name                 | Value                                      |
|----------------------|--------------------------------------------|
| `CLIENT_REMOTE_HOST` | `paradox-mmo-production.up.railway.app`    |
| `CLIENT_REMOTE_PORT` | `443`                                      |
| `SSL`                | `true`                                     |
| `NAME`               | `Paradox`                                  |

После ввода значений нажать **Redeploy**.

### Шаг 4. Runtime Variables

Service → **Variables**, добавить (или проверить что выставлены):

| Name               | Value      | Комментарий                                 |
|--------------------|------------|---------------------------------------------|
| `ACCEPT_LICENSE`   | `true`     | Обязательно, иначе сервер не стартует       |
| `SKIP_DATABASE`    | `true`     | Играть без MongoDB                          |
| `HOST`             | `0.0.0.0`  | Bind на все интерфейсы контейнера           |
| `MAX_PLAYERS`      | `50`       | Лимит одновременных игроков                 |
| `TUTORIAL_ENABLED` | `false`    | Туториал забит в MongoDB, при SKIP ломает   |
| `OVERWRITE_AUTH`   | `true`     | Любой логин работает, регистрация не нужна  |

`PORT` Railway проставит сам — Kaetram читает `process.env.PORT` автоматически.

### Шаг 5. Играть

Открыть `https://paradox-mmo-production.up.railway.app`, ввести любой ник, дать ссылку друзьям.

## Что было изменено в форке

1. **`packages/server/src/network/websocket.ts`** — метод `httpResponse` переписан: вместо строки *"This is server, why are you here?"* сервер раздаёт статику клиента из `/app/client-dist` (Astro bundle). uWS держит HTTP и WebSocket на одном порту → один Railway service вместо двух.
2. **`Dockerfile`** — multi-stage build: ставит Yarn, собирает server и client последовательно, копирует client dist в финальный образ рядом с server dist.
3. **`railway.toml`** — build через Dockerfile, healthcheck на `/`, автоперезапуск при падении.

Архитектурные особенности форка (почему SKIP_DATABASE):
- MongoDB не нужна для MVP — прогресс игроков не сохраняется между сессиями
- Туториал при `SKIP_DATABASE=true` ломается → выключаем `TUTORIAL_ENABLED=false`
- Авторизация через `OVERWRITE_AUTH=true` — любой логин/пароль принимается, регистрация не нужна

Когда захотите сохранение прогресса:
- Добавьте MongoDB service в Railway (Template → MongoDB)
- Уберите `SKIP_DATABASE` или поставьте `false`
- Пропишите `MONGODB_HOST`, `MONGODB_PORT`, `MONGODB_USER`, `MONGODB_PASSWORD` из Railway-переменных MongoDB
- Включите обратно `TUTORIAL_ENABLED=true`

## Локальный запуск

Требуется Node.js 22+, Yarn (через corepack).

```bash
git clone https://github.com/21deni19zzz-dotcom/paradox-mmo.git
cd paradox-mmo
corepack enable
yarn install

# Принять лицензию + отключить БД
cp .env.defaults .env
sed -i 's/ACCEPT_LICENSE=false/ACCEPT_LICENSE=true/' .env

yarn dev
# Клиент: http://localhost:3000
# Сервер: ws://localhost:9001
```

## Ограничения текущего MVP

- **Нет persistence.** Выйдете — прогресс обнулится. Фикс: добавить MongoDB (см. выше).
- **Free tier Railway** даёт $5 credit в месяц. На 2-5 игроков хватит с запасом, на 20+ придётся следить за расходом.
- **Без CDN.** Статика раздаётся самим сервером, для 10 игроков это ок, для 100+ стоит вынести клиент на Vercel/Cloudflare Pages.

## Лицензия

Код — MPL-2.0 + OPL (см. `LICENSE`, `LICENSE_OPL`). Оригинал — [Kaetram-Open](https://github.com/Kaetram/Kaetram-Open), кредиты обязаны оставаться на главной странице клиента согласно OPL.

Ассеты — CC-BY-SA 3.0, наследуются от BrowserQuest (Mozilla).
