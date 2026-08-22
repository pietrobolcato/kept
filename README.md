# Kept

Kept is a self-hostable visual memory for the things you do not want to lose. Save links, images, videos, and notes; let AI describe and file them; then recover them through semantic, visual, colour, and date-aware search.

It includes:

- A responsive, installable React web app.
- Email/password accounts and a private Supabase library protected by row-level security.
- Automatic Anthropic classification and a streaming assistant that can search, compare, create, edit, move, and remove memories with confirmation.
- Voyage embeddings, typo-tolerant relevance ranking, deterministic filters, and colour search.
- Durable private copies of uploads, videos, and link previews in Supabase Storage.
- Personal spaces, whole-library or per-space collaboration, and permissioned invitation links.
- Telegram capture, a Chrome/Arc extension, and a guided Apple Notes/Photos importer.

## Quick start

You need Node.js 20+, npm, and a Supabase project you control.

```bash
git clone https://github.com/YOUR_ACCOUNT/kept.git
cd kept
npm ci
cp .env.example .env
```

Fill in the Supabase values in `.env`, apply the database migrations, and start the app:

```bash
npx supabase@latest link --project-ref YOUR_PROJECT_REF
npx supabase@latest db push
npm run dev
```

Open [http://127.0.0.1:3456](http://127.0.0.1:3456). Anthropic and Voyage are optional for booting, but strongly recommended for the experience Kept is designed to provide.

**Continue with the complete [self-hosting guide](docs/self-hosting.md).** It covers every provider key, Supabase Auth and Storage, Vercel and generic Node deployment, Telegram, the browser extension, verification, backups, and upgrades.

For an autonomous coding agent, use the [agent setup runbook](docs/agent-setup.md). It separates commands an agent may run from provider-account steps that require the operator.

## Architecture

```text
React + Vite PWA ─┐
Chrome extension ─┼─> Express API ─> Supabase Auth / Postgres / private Storage
Telegram webhook ─┘         ├──────> Anthropic (vision, assistant, web search)
                            └──────> Voyage AI (512-dimensional embeddings)
```

The browser receives only Supabase's publishable key. `SUPABASE_SERVICE_ROLE_KEY`, Anthropic, Voyage, and Telegram credentials are server-only. Normal application requests carry the signed-in user's Supabase JWT and remain constrained by database and Storage policies.

## Development

```bash
npm run dev            # Vite on :3456 and Express on :8787
npm run check          # types, lint, tests, and production build
npm run check:release  # ignored-file and credential safety audit
```

For a generic Node host:

```bash
npm run build
HOST=0.0.0.0 PORT=8787 npm start
```

Additional guides:

- [Apple Notes, Markdown, and Photos import](docs/apple-import.md)
- [Chrome/Arc capture extension](chrome-extension/README.md)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)

## Privacy defaults

- User data is never part of the repository; `data/`, `uploads/`, local env files, build output, provider state, and browser test artifacts are ignored.
- Memory rows and private objects are protected by Supabase RLS and Storage policies.
- Link preview images are archived into private Storage so a later page outage does not remove the saved visual.
- Device images attached only to an assistant question are transient and are not added to the library.
- Library-changing assistant actions always require explicit confirmation.

Before publishing a fork, run `npm run check:release`. The script audits exactly the tracked and unignored files Git would publish and fails on common credential formats or private runtime data.

## License

[MIT](LICENSE)
