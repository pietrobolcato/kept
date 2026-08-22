# Importing Apple Notes, Markdown, and Photos

Kept includes a one-time macOS importer for one Apple Note and one Photos album. It uses Apple’s local scripting interfaces, renders album images into browser-compatible files, and sends them through Kept’s normal classification pipeline.

It can also import links from any Markdown file. Markdown mode works without Apple Notes or Photos access:

```bash
npm run import:apple -- --markdown path/to/saved-links.md --dry-run
npm run import:apple -- --markdown path/to/saved-links.md
```

Create your Kept account in the browser first. Actual imports authenticate as that account so Supabase row-level security files every result into the correct private library. `--list` and `--dry-run` do not require a login.

## Recommended flow

Run the interactive importer from the project directory, providing the receiving account through temporary environment variables:

```bash
KEPT_EMAIL=you@example.com KEPT_PASSWORD='your password' npm run import:apple
```

You can instead pass `--email you@example.com`. The password is read from `KEPT_PASSWORD` by default; `--password-env NAME` selects a different environment variable. It is never written to the manifest or `.env` by the importer.

It lists note and album names, then asks you to choose one of each. Enter `0` to skip either source. The first run may trigger macOS permission prompts for Notes or Photos automation; approve those for the terminal app running the command.

If Photos automation was previously denied, open **System Settings → Privacy & Security → Automation**, find the terminal app running the command, and enable **Photos**. Notes-only imports continue to work while Photos automation is unavailable.

For a preview without saving anything:

```bash
npm run import:apple -- --note "My saved things" --album "Home inspiration" --dry-run
```

When the dry-run looks right, remove `--dry-run` and provide the receiving account:

```bash
KEPT_EMAIL=you@example.com KEPT_PASSWORD='your password' npm run import:apple -- --note "My saved things" --album "Home inspiration"
```

You can inspect the available names first:

```bash
npm run import:apple -- --list
```

## What gets imported

- Every unique HTTP(S) link found in the note’s rich text, plain text, or URL attachments becomes an individually classified link.
- Every unique inline, reference-style, autolink, or visible HTTP(S) URL found in a Markdown file is handled the same way.
- If a note has no links, its text becomes one classified note.
- Add `--include-note-text` to also keep the remaining text from a link-filled note.
- Supported Photos album images are exported as rendered files, resized to a maximum 1920px edge, encoded as quality-76 WebP, and uploaded individually. Videos are transcoded to broadly playable MP4, compressed below 48 MB, and stored with a generated poster. Override image defaults with `--max-image-edge` and `--image-quality` when needed. Video import requires `ffmpeg` (for example, `brew install ffmpeg`).

The Photos export is temporary and deleted when the run ends. Add `--keep-export` if you explicitly want to retain that rendered export for inspection.

## Safety and resuming

- Nothing is changed until you choose a source.
- `--dry-run` never calls the Kept API.
- Imported links are checked against the current library.
- Successful imports are recorded in `data/import-manifest.json`, so rerunning the same source skips completed items and resumes failures.
- Photos items are tracked by their stable asset ID, so changing compression settings or rerunning a large album does not create another copy.
- The local manifest, legacy local data, and API keys are ignored by git. Imported metadata and images are stored in the signed-in user’s Supabase database and private Storage folder.
- If Kept is not running locally, the importer starts the API for the duration of the import and stops it afterwards.

Apple Notes exposes text and URL attachments but does not provide a general attachment export command. Embedded non-URL Notes attachments are counted and reported, but cannot be imported automatically by this script. Photos images are unaffected by that limitation.
