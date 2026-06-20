# Psychologist Telegram Agent

Cloudflare Worker для Telegram-бота и админ-дашборда психолога. Проект хранит код сайта и Worker runtime. Секреты, локальные данные, R2 state, node_modules и тестовые артефакты не входят в репозиторий.

## Runtime

- Cloudflare Workers + Assets
- Durable Object `ChatMemory`
- R2 bucket binding `BOT_OBJECTS`
- Public site `/`
- Public site API `/site/api/*`
- Telegram webhook `/telegram/webhook`
- Admin dashboard `/bot/`
- Admin API `/bot/api/*`
- Google OAuth callback `/bot/api/auth/google/callback`

## Repository layout

- `bot/src/` — Cloudflare Worker backend: Telegram webhook, admin API, public site API, memory, calendar, storage.
- `dashboard/` — source assets for the psychologist dashboard.
- `site/` — source assets for the public site.
- `public/` — generated Cloudflare Assets directory. Do not edit it directly; run `npm run build:assets`.

## Local Development

```powershell
npm ci
npm run check
npm run build:assets
npm run dev
```

Для локальных секретов используйте `.dev.vars`. Файл `.dev.vars` исключен из Git.

## Required Cloudflare Secrets

```powershell
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put OPENROUTER_API_KEY
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put GOOGLE_ADMIN_EMAIL
```

Опционально:

```powershell
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put GOOGLE_ADMIN_EMAILS
npx wrangler secret put TURNSTILE_SECRET_KEY
```

`GOOGLE_ADMIN_EMAIL` хранит основной Google-аккаунт администратора. `GOOGLE_ADMIN_EMAILS` хранит дополнительные разрешенные email через запятую или пробел. Парольный вход в дашборд отключен; браузерный вход работает через Google OAuth allowlist.

## GitHub Actions Deploy

Workflow `.github/workflows/deploy.yml` деплоит Worker после push в `main`.

Этот репозиторий является публичным источником для всего Cloudflare Worker:

- `https://тупа.рф/` отдаёт публичный сайт.
- `https://тупа.рф/site/api/*` отдаёт public API сайта.
- `https://тупа.рф/bot/` отдаёт admin dashboard.
- `https://тупа.рф/bot/api/*` отдаёт admin API после Google OAuth.
- `https://тупа.рф/telegram/webhook` принимает Telegram webhook.

Нужны GitHub repository secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Секреты бота остаются в Cloudflare Workers secrets и не должны попадать в GitHub.

## Google Console

- OAuth Client type: Web application
- Redirect URI: `https://xn--80a3aie.xn--p1ai/bot/api/auth/google/callback`
- Scope: `https://www.googleapis.com/auth/calendar.events`

## Safety

- Admin routes require Google OAuth cookie session or bearer token for operational automation.
- Telegram webhook requires `X-Telegram-Bot-Api-Secret-Token`.
- Client transcripts and profiles are stored in R2/Durable Objects.
- The bot must not diagnose, promise treatment, or replace emergency help.
