# Agent setup runbook

This is the deterministic setup path for a coding or operations agent. The human-facing explanation is in [self-hosting.md](self-hosting.md).

## Safety contract

1. Never read, echo, log, paste, or commit actual secret values.
2. Ask the operator to place secrets in `.env` locally and in the deployment provider's secret manager. Verify only whether each variable is present.
3. Never put a Supabase secret/service-role key, Anthropic key, Voyage key, Telegram token, or webhook secret in a `VITE_` variable.
4. Run `npm run check:release` before staging or publishing.
5. Database pushes, production deployments, webhook changes, and GitHub publication mutate external state. Perform them only when the operator has requested that step and the exact project/target is known.

## Inputs to obtain

The operator must provide or configure:

| Input | Required | Where it belongs |
| --- | --- | --- |
| Supabase project ref | Yes | CLI argument; not secret |
| Supabase URL | Yes | `.env` and host environment |
| Supabase publishable/anon key | Yes | `.env` and host environment; browser-visible |
| Anthropic API key | Recommended | Server environment only |
| Voyage API key | Recommended | Server environment only |
| Supabase secret/service-role key | Telegram/backfills only | Server environment only |
| Telegram bot token, username, webhook secret | Telegram only | Server environment only |
| Final HTTPS application URL | Deployment/Telegram/extension | Supabase Auth and client setup |

Do not ask the operator to paste secrets into chat. Ask them to populate `.env` or the provider's secret UI and confirm when done.

## Phase A — local repository

```bash
npm ci
test -f .env || cp .env.example .env
```

Stop if `.env` still contains placeholder Supabase values. A safe presence-only check is:

```bash
node -e "import('dotenv/config').then(()=>{for(const k of ['VITE_SUPABASE_URL','VITE_SUPABASE_ANON_KEY','SUPABASE_URL','SUPABASE_ANON_KEY'])if(!process.env[k]||process.env[k].startsWith('your_'))throw new Error('Missing '+k);console.log('Required Supabase variables are present')})"
```

The command intentionally prints no values.

## Phase B — Supabase

Confirm the exact project reference with the operator, then:

```bash
npx supabase@latest login
npx supabase@latest link --project-ref PROJECT_REF
npx supabase@latest db push --dry-run
```

Inspect the dry run. If it targets the intended project and the operator authorized migration:

```bash
npx supabase@latest db push
npx supabase@latest config push
```

The operator must confirm in the Supabase dashboard that email/password Auth is enabled, email confirmation matches their policy, and Site/Redirect URLs include local and production Kept URLs.

## Phase C — local verification

```bash
npm run check
npm run dev
```

Verify without printing secrets:

```bash
curl -fsS http://127.0.0.1:8787/api/health
```

Expected: HTTP 200, `ok` and `auth` true. `ai` is true only with Anthropic configured; `semanticSearch` is true only with Voyage configured.

The operator should create a disposable account and manually verify signup, one link capture, one image capture, one search, and one assistant reply. Do not import personal data as a smoke test.

## Phase D — publication audit

```bash
npm run check:release
git status --short --ignored
git diff --cached --check
```

Confirm that `.env`, `.env.local`, `.vercel`, `data/*`, `uploads/*`, `output`, `dist`, generated `public/assets`, and browser artifacts are ignored and absent from the staged set. If any credential was ever committed, stop: the operator must rotate it before publication.

## Phase E — deployment

For Vercel, link the intended project and add all required environment values through Vercel's secret UI. `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` must exist at build time. Then, with explicit deployment authorization:

```bash
npx vercel@latest
npx vercel@latest --prod
```

For a generic Node host, configure:

```text
Build: npm ci && npm run build
Start: HOST=0.0.0.0 PORT=<platform-port> npm start
Health: GET /api/health
```

After the final URL exists, the operator must update Supabase Auth Site URL and Redirect URLs. Verify `/api/health`, signup/login, capture, refresh persistence, and realtime updates in production.

## Phase F — optional integrations

Apple Shortcut: confirm `SUPABASE_SERVICE_ROLE_KEY` and `PUBLIC_APP_URL=https://FINAL_DOMAIN` are server-only deployment variables. The signed Shortcut is already in `public/downloads`; rebuilding it requires macOS, Cherri, and `npm run shortcut:build`. Pairing itself is performed by each signed-in user under **Add from phone**.

Telegram, only after all four server values are configured and the operator authorizes changing the webhook:

```bash
npm run telegram:webhook -- https://FINAL_DOMAIN
```

Browser extension: load `chrome-extension` unpacked, open its options, enter `https://FINAL_DOMAIN`, sign in, and assign shortcuts.

Apple import: follow [apple-import.md](apple-import.md), always run `--list` and `--dry-run` first, and do not execute a real import without explicit approval of the selected note/album and receiving account.

## Completion report

Report:

- repository checks and tests run;
- Supabase project ref (never keys) and migration status;
- deployment URL and `/api/health` feature booleans;
- which optional integrations were configured;
- any manual dashboard steps still outstanding;
- confirmation that `npm run check:release` passed and private runtime files are untracked.
