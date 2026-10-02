#!/usr/bin/env bash
# Installs assets/quick-task-manager.desktop into the user's application menu.
#
# The entry's Exec and Icon lines need absolute paths, so they are rewritten to
# point at this checkout, wherever it lives. Run `npm run build` first: the
# entry starts launch.sh, which runs the production build.
set -euo pipefail

ROOT="$(dirname "$(readlink -f "$0")")"
APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
DEST="$APPS/quick-task-manager.desktop"

mkdir -p "$APPS"
sed -e "s|^Exec=.*|Exec=$ROOT/launch.sh|" \
    -e "s|^Icon=.*|Icon=$ROOT/assets/icon.svg|" \
    "$ROOT/assets/quick-task-manager.desktop" > "$DEST"
chmod +x "$DEST"

if command -v desktop-file-validate >/dev/null; then
  desktop-file-validate "$DEST"
fi
if command -v update-desktop-database >/dev/null; then
  update-desktop-database "$APPS" || true
fi

echo "Installed $DEST"
[ -d "$ROOT/out" ] || echo "Note: no build found; run 'npm run build' before launching from the menu."
