#!/usr/bin/env bash
# Launches the production build. Used by the .desktop entry so the app can be
# started from the XFCE menu instead of `npm run dev`.
#
# The menu runs this with the desktop session's environment, which does NOT
# source ~/.bashrc. Anything that relies on an interactive shell (notably nvm's
# node on PATH) is therefore unavailable here and has to be resolved by hand.
set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")"

LOG="${XDG_CACHE_HOME:-$HOME/.cache}/quick-task-manager-launch.log"
mkdir -p "$(dirname "$LOG")"
exec 2> >(tee -a "$LOG" >&2)

die() {
  echo "$1" >&2
  # Terminal=false means stderr is invisible from the menu, so say it onscreen.
  if command -v zenity >/dev/null 2>&1; then
    zenity --error --title="Quick Task Manager" --text="$1"$'\n\n'"Log: $LOG" 2>/dev/null || true
  elif command -v xmessage >/dev/null 2>&1; then
    xmessage -center "$1" || true
  fi
  exit 1
}

# nvm installs node outside the default PATH; find the version its `default`
# alias points at (falling back to the newest installed).
ensure_node_on_path() {
  command -v node >/dev/null 2>&1 && return 0

  local nvm_dir="${NVM_DIR:-$HOME/.nvm}" want="" candidate=""
  [ -r "$nvm_dir/alias/default" ] && want="$(<"$nvm_dir/alias/default")"
  [ -n "$want" ] && candidate="$(ls -d "$nvm_dir/versions/node/v${want#v}"* 2>/dev/null | sort -V | tail -1)"
  [ -n "$candidate" ] || candidate="$(ls -d "$nvm_dir"/versions/node/v* 2>/dev/null | sort -V | tail -1)"

  [ -n "$candidate" ] && [ -x "$candidate/bin/node" ] || return 1
  PATH="$candidate/bin:$PATH"
  export PATH
}

# The out/ directory is gitignored, so build on first run (or after a clean).
if [ ! -f out/main/index.js ]; then
  ensure_node_on_path || die "No build in out/ and node was not found — run 'npm run build' in a terminal first."
  npm run build || die "npm run build failed."
fi

# better-sqlite3 is a native module and must match Electron's ABI. If it was
# rebuilt for plain node, the main process throws on require and the window
# never appears — so surface that as a dialog rather than a silent no-op.
[ -f node_modules/better-sqlite3/build/Release/better_sqlite3.node ] \
  || die "better-sqlite3 is not built — run 'npm run rebuild' in a terminal."

# Run electron's native binary rather than node_modules/.bin/electron, which is
# a '#!/usr/bin/env node' script and so needs node on PATH.
ELECTRON=node_modules/electron/dist/electron
[ -x "$ELECTRON" ] || die "Electron binary missing at $ELECTRON — run 'npm install' in a terminal."

# chrome-sandbox isn't setuid root in node_modules, same reason dev passes --noSandbox.
exec "$ELECTRON" --no-sandbox . "$@"
