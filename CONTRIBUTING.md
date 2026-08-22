# Contributing

Thank you for helping improve Kept.

1. Create a focused branch from the latest default branch.
2. Keep credentials and personal library data in ignored local files only.
3. Run `npm ci`, then `npm run check` and `npm run check:release`.
4. Explain behaviour changes, migration requirements, and manual verification in the pull request.
5. Add a Supabase migration for schema changes; do not edit an already-published migration.

Please keep captures private by default, preserve row-level security, and require explicit confirmation for destructive or assistant-initiated writes. New provider integrations should fail gracefully when their key is absent.
