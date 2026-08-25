# Security

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use the repository's **Security → Report a vulnerability** flow, or contact the maintainer privately if private reporting has not yet been enabled.

Include the affected route or component, reproduction steps, expected impact, and any suggested mitigation. Do not include real API keys, access tokens, personal memories, or other users' data.

## Secrets

Kept has two classes of environment value:

- `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are intentionally browser-visible. Supabase RLS remains the security boundary.
- Anthropic, Voyage, Telegram, and Supabase secret/service-role keys are server-only. Never prefix them with `VITE_`, paste them into client code, commit `.env`, or expose them in screenshots and issue logs.

The public Apple Shortcut contains no user session or provider secret. Pairing codes expire after ten minutes and work once; capture credentials are random, revocable, and stored in Postgres only as SHA-256 hashes. Treat the private `Kept/connection.json` file in the user's Shortcuts iCloud folder as an account credential and revoke the connection from Kept if it may have been copied.

If a secret is committed, revoke or rotate it at the provider immediately. Rewriting Git history alone does not make a published credential safe again.

Run `npm run check:release` before every public release. It is an additional guardrail, not a replacement for provider-side secret scanning and branch protection.
