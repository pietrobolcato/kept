#!/bin/sh
set -eu

if ! command -v cherri >/dev/null 2>&1; then
  echo "Install Cherri first: brew tap electrikmilk/cherri && brew install electrikmilk/cherri/cherri" >&2
  exit 1
fi

mkdir -p public/downloads
cherri apple-shortcut/Keep-in-Kept.cherri --share=anyone --derive-uuids --output=public/downloads/Keep-in-Kept.shortcut
chmod 644 public/downloads/Keep-in-Kept.shortcut
unsigned_shortcut='apple-shortcut/Keep in Kept_unsigned.shortcut'
if [ -f "$unsigned_shortcut" ]; then
  # BSD/macOS mktemp requires the Xs to end the template.
  debug_copy="$(mktemp /tmp/Keep-in-Kept-unsigned.XXXXXX)"
  mv "$unsigned_shortcut" "$debug_copy"
fi
echo "Built public/downloads/Keep-in-Kept.shortcut"
