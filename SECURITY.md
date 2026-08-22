# Security

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use the repository's **Security → Report a vulnerability** flow, or contact the maintainer privately if private reporting has not yet been enabled.

Include the affected route or component, reproduction steps, expected impact, and any suggested mitigation. Do not include real API keys, access tokens, personal memories, or other users' data.

## Secrets

Kept has two classes of environment value:

- `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are intentionally browser-visible. Supabase RLS remains the security boundary.
- Anthropic, Voyage, Telegram, and Supabase secret/service-role keys are server-only. Never prefix them with `VITE_`, paste them into client code, commit `.env`, or expose them in screenshots and issue logs.

If a secret is committed, revoke or rotate it at the provider immediately. Rewriting Git history alone does not make a published credential safe again.

Run `npm run check:release` before every public release. It is an additional guardrail, not a replacement for provider-side secret scanning and branch protection.
