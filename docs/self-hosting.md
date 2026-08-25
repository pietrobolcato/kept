# Self-hosting Kept

This guide deploys Kept with a Supabase project you own and either Vercel or any Node.js host. A local-only Supabase option is included at the end.

## 1. What you need

Required:

- [Node.js](https://nodejs.org/) 20 or newer and npm.
- A [Supabase](https://supabase.com/dashboard) project.
- A Git host if you plan to deploy through Vercel's dashboard.

Recommended:

- An [Anthropic Console](https://console.anthropic.com/) API key for classification, visual understanding, link-preview selection, web discovery, and Ask Kept.
- A [Voyage AI](https://dash.voyageai.com/) API key for semantic search and retrieval.

Optional:

- A [Vercel](https://vercel.com/) account, or another host that runs Node.js.
- A Telegram bot token from [BotFather](https://t.me/BotFather).
- macOS with Apple Notes/Photos access for the one-time importer. Video import also needs `ffmpeg`.

Provider accounts and model APIs may cost money. Review each provider's current limits before importing a large library.

## 2. Install the source

```bash
git clone https://github.com/YOUR_ACCOUNT/kept.git
cd kept
npm ci
cp .env.example .env
```

`.env` is ignored by Git. Keep it local and private.

## 3. Create and migrate Supabase

Create a project in the Supabase dashboard. Save its project reference and database password in a password manager. Then authenticate the CLI, link this checkout, and apply every migration:

```bash
npx supabase@latest login
npx supabase@latest link --project-ref YOUR_PROJECT_REF
npx supabase@latest db push --dry-run
npx supabase@latest db push
npx supabase@latest config push
```

Review the dry run before the actual push. The migrations create the pgvector extension, private memory and conversation tables, spaces and sharing, Telegram pairing, taste profiles, date/location fields, deduplication fields, a private Storage bucket, and their row-level-security policies.

In **Supabase Dashboard → Authentication → URL Configuration**:

1. Set **Site URL** to the final Kept URL (for example `https://kept.example.com`). Use `http://127.0.0.1:3456` until you deploy.
2. Add `http://127.0.0.1:3456`, `http://localhost:3456`, and your production URL to **Redirect URLs**.

In **Authentication → Providers → Email**:

1. Enable email/password signup.
2. Disable email confirmation if this is a private/internal instance and you want immediate signup, matching the repository configuration.

The final migration permits Storage objects up to 200 MB. Your Supabase plan's project-wide upload limit still wins if it is lower. The Apple importer compresses videos below 48 MB for compatibility with lower-limit projects.

## 4. Configure environment variables

Open **Supabase Dashboard → Project Settings → API** (or the project's **Connect** dialog) and fill these in `.env`:

```dotenv
VITE_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_PUBLISHABLE_KEY
SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
SUPABASE_ANON_KEY=YOUR_PUBLISHABLE_KEY
```

The URL and publishable/anon key are expected in the browser. Security comes from Supabase Auth, RLS, and Storage policies. Do not use a secret or service-role key in either `VITE_` variable.

For the intended AI experience, add:

```dotenv
ANTHROPIC_API_KEY=YOUR_ANTHROPIC_API_KEY
ANTHROPIC_MODEL=claude-sonnet-5
VOYAGE_API_KEY=YOUR_VOYAGE_API_KEY
VOYAGE_MODEL=voyage-4
```

Kept requests 512-dimensional Voyage vectors because the database column is `vector(512)`. If you change the embedding model, it must support that output dimension; changing dimensions also requires a new migration and a full re-index.

Without Anthropic, capture falls back to basic deterministic classification and the assistant is unavailable. Without Voyage, text and deterministic filters still work but semantic ranking is unavailable.

The service-role/secret key is not needed for normal browser use. Add it only for Apple Shortcut capture, Telegram, and administrative backfills:

```dotenv
SUPABASE_SERVICE_ROLE_KEY=YOUR_SUPABASE_SECRET_OR_LEGACY_SERVICE_ROLE_KEY
PUBLIC_APP_URL=https://YOUR_DOMAIN
```

This value bypasses RLS. It must exist only in the server environment and must never be prefixed with `VITE_`.

## 5. Run and verify locally

```bash
npm run dev
```

Open `http://127.0.0.1:3456`, create an account, and save one link and one image. Then verify the API separately:

```bash
curl -fsS http://127.0.0.1:8787/api/health
```

The JSON response should show `ok: true`, `auth: true`, and—if configured—`ai: true` and `semanticSearch: true`.

Before deploying:

```bash
npm run check
npm run check:release
```

## 6A. Deploy on Vercel

Push the sanitized repository to GitHub, GitLab, or Bitbucket and import it in Vercel, or use the CLI:

```bash
npx vercel@latest link
npx vercel@latest
```

In **Vercel → Project → Settings → Environment Variables**, add the same values from section 4. Add both `VITE_` variables to every environment you build; Vite reads them at build time. Keep all provider and service keys server-side even though Vercel stores them in the same settings screen.

Deploy production:

```bash
npx vercel@latest --prod
```

Return to Supabase Auth URL Configuration and set the production Site URL and Redirect URL. Check:

```bash
curl -fsS https://YOUR_DOMAIN/api/health
```

## 6B. Deploy on another Node host

Use these build and start commands:

```bash
npm ci
npm run build
HOST=0.0.0.0 PORT=8787 npm start
```

Set all environment variables through the host's secret manager. Terminate HTTPS at the platform proxy and expose the configured `PORT`. The Express process serves both the API and the built web app in production.

## 7. Optional Apple Shortcut capture

Kept includes a signed, reusable **Keep in Kept** Shortcut in `public/downloads`. It accepts links, text, photos, and videos from the iPhone/iPad Share Sheet. The public Shortcut contains no account credential. Each device exchanges a ten-minute, one-use pairing code for a random revocable capture token; the database stores only its SHA-256 hash.

1. Set `SUPABASE_SERVICE_ROLE_KEY` and the canonical `PUBLIC_APP_URL` on the server, then deploy.
2. In Kept, sign in and choose **Add from phone**.
3. Tap **Install Shortcut** and confirm **Add Shortcut** in Apple's Shortcuts app.
4. Return to Kept and tap **Connect**. Kept launches the installed Shortcut with the one-use pairing payload.
5. Share something from any app, choose **Keep in Kept**, then choose a current personal or editable shared destination.

Kept lists the current Shortcut connection with its last-used date and lets the owner revoke it immediately. A revoked Shortcut is refused on its next request. The private configuration is stored in the user's Shortcuts iCloud folder and can therefore follow that user's Apple devices; reconnecting replaces the previous credential. If a user has imported but not connected the Shortcut, Kept cannot distinguish that from a missing installation; iOS provides no website API for inspecting installed Shortcuts.

The checked-in signed file is ready to use. Maintainers changing `apple-shortcut/Keep-in-Kept.cherri` can rebuild it on macOS:

```bash
brew tap electrikmilk/cherri
brew install electrikmilk/cherri/cherri
npm run shortcut:build
```

The build signs the result for **Anyone** through Apple's local `shortcuts` signing service. Commit the regenerated `public/downloads/Keep-in-Kept.shortcut` together with its source change.

## 8. Optional Telegram capture

1. Open BotFather in Telegram, run `/newbot`, and save the bot token.
2. Put the token and username in the deployment's server environment.
3. Generate a webhook secret locally with `openssl rand -hex 32`; store it in the deployment environment.
4. Redeploy, then register the webhook from a checkout whose `.env` contains the same values.

```dotenv
TELEGRAM_BOT_TOKEN=YOUR_BOTFATHER_TOKEN
TELEGRAM_BOT_USERNAME=YOUR_BOT_USERNAME_WITHOUT_AT
TELEGRAM_WEBHOOK_SECRET=YOUR_RANDOM_WEBHOOK_SECRET
SUPABASE_SERVICE_ROLE_KEY=YOUR_SUPABASE_SECRET_OR_LEGACY_SERVICE_ROLE_KEY
```

```bash
npm run telegram:webhook -- https://YOUR_DOMAIN
```

The helper validates the bot, registers `https://YOUR_DOMAIN/api/telegram/webhook`, and never prints the token. In Kept, sign in, choose **Add from phone**, create a one-time pairing link, and press **Start** in Telegram. Each Telegram account pairs to one Kept account. Personal libraries and editable shared libraries are available as remembered destinations: choose one under **Add from phone**, or send `/destination` to the bot. Every success reply names the destination library and space, and exact duplicates are not added twice.

## 9. Optional Chrome or Arc extension

1. Open `chrome://extensions` (or `arc://extensions`).
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select the repository's `chrome-extension` folder.
4. Open the extension's **Details → Extension options**.
5. Enter your production Kept URL and sign in.
6. Assign shortcuts at `chrome://extensions/shortcuts` or `arc://extensions/shortcuts`.

The extension stores the chosen instance URL and the user's refreshable Supabase session in extension-local storage. Changing instances clears the previous session.

## 10. Optional Apple import

On the Mac containing the source library, install `ffmpeg` if the album includes videos:

```bash
brew install ffmpeg
```

Add `KEPT_EMAIL` and `KEPT_PASSWORD` to the local `.env`, preview the selection, then import:

```bash
npm run import:apple -- --list
npm run import:apple -- --note "Saved things" --album "Inspiration" --dry-run
npm run import:apple -- --note "Saved things" --album "Inspiration"
```

For a deployed API, append `--api https://YOUR_DOMAIN`. See [Apple import details](apple-import.md).

## 11. Fully local Supabase for development

This requires Docker. It is useful for development, but operating Supabase itself in production is a separate infrastructure responsibility.

```bash
npx supabase@latest start
npx supabase@latest db reset
npx supabase@latest status
```

Copy the local API URL, anon key, and—only if needed—service-role key printed by `status` into `.env`. The checked-in `supabase/config.toml` already allows the local Kept URLs and immediate email signup.

## 12. Backups and upgrades

- Enable Supabase backups appropriate to your plan and periodically test a restore.
- Back up both Postgres and the private `kept-images` Storage bucket; either alone is incomplete.
- Before an upgrade, read new migrations, back up the project, then run `npm ci`, `npx supabase@latest db push --dry-run`, `npx supabase@latest db push`, and `npm run check`.
- Rotate provider keys immediately if they appear in a commit, log, screenshot, support ticket, or chat. Removing the text from Git history is not sufficient after disclosure.

## Troubleshooting

- **Blank app after deploy:** confirm both `VITE_SUPABASE_*` variables existed during the build, rebuild, and hard-refresh.
- **Signup works but login redirects incorrectly:** fix Supabase Site URL and Redirect URLs.
- **Assistant unavailable:** check `ANTHROPIC_API_KEY`, the selected model's availability, and `/api/health`.
- **Semantic results missing:** check `VOYAGE_API_KEY`; do not change the 512-dimensional contract without a migration.
- **Video upload rejected:** compare the file size with both the `kept-images` bucket limit and the project's global Storage limit.
- **Extension cannot connect:** enter the full deployed `https://` URL in Extension options and ensure `/api/extension/config` returns JSON.
- **Shortcut does not open during Connect:** install **Keep in Kept** first, return to the open Kept sheet, and tap **Connect** again. Confirm `PUBLIC_APP_URL` uses the deployed HTTPS origin.
- **Shortcut says its connection was revoked:** open **Add from phone** and connect it again. Never paste a Supabase access token or service key into the Shortcut.
- **Telegram does not answer:** redeploy after setting all four Telegram/service variables, rerun `npm run telegram:webhook`, and verify that the public webhook URL is HTTPS.
