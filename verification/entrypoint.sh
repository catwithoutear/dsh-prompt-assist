#!/usr/bin/env bash
set -euo pipefail
umask 022

ARTIFACTS="${ARTIFACTS_DIR:-/artifacts}"
DSH_HOME="${DSH_HOME:-/verify/home}"
WEB_PORT="${WEB_PORT:-18080}"
MOCK_PORT=18090

case "$ARTIFACTS" in
  /|"") echo "refusing unsafe ARTIFACTS_DIR: $ARTIFACTS" >&2; exit 2 ;;
esac
case "$DSH_HOME" in
  /|/verify|/artifacts|"") echo "refusing unsafe DSH_HOME: $DSH_HOME" >&2; exit 2 ;;
esac

mkdir -p "$ARTIFACTS" "$DSH_HOME"
rm -rf "$DSH_HOME"
mkdir -p "$DSH_HOME"
rm -rf "$ARTIFACTS/screens" "$ARTIFACTS/test-results"
rm -f "$ARTIFACTS/llm-requests.jsonl"

finish() {
  # Root-owned artifacts must stay readable and removable by the caller and by
  # actions/upload-artifact; copied files otherwise keep 0600 from the source.
  chmod -R a+rwX "$ARTIFACTS" 2>/dev/null || true
}
trap finish EXIT

# DSH's Linux first-use workspace resolver runs `xdg-user-dir DOCUMENTS`.
# Container images do not have a Documents directory or user-dirs config.
mkdir -p "$HOME/Documents" "$HOME/.config"
if [ ! -f "$HOME/.config/user-dirs.dirs" ]; then
  printf 'XDG_DOCUMENTS_DIR="$HOME/Documents"\n' > "$HOME/.config/user-dirs.dirs"
fi
xdg-user-dirs-update 2>/dev/null || true

install -m 0644 /verify/fixtures/settings.yaml "$DSH_HOME/settings.yaml" \
  || { echo "missing settings fixture" >&2; exit 2; }

export MOCK_API_KEY=fixture
export DSH_HOME
export ARTIFACTS_DIR="$ARTIFACTS"
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/ms-playwright}"

node /verify/fixtures/mock-llm.mjs > "$ARTIFACTS/mock-llm.log" 2>&1 &
MOCK_PID=$!

{
  echo "dsh version: $(dsh --version 2>&1)"
  echo "node: $(node --version)"
  echo "npm: $(npm --version)"
  echo "pnpm: $(pnpm --version 2>&1)"
  echo "dsh version requested: ${DSH_VERSION:-unknown}"
} > "$ARTIFACTS/entry.log"

if ! dsh plugin --profile web add /verify/plugin.tgz > "$ARTIFACTS/plugin-install.log" 2>&1; then
  echo "plugin install failed" >> "$ARTIFACTS/entry.log"
  tail -40 "$ARTIFACTS/plugin-install.log" >> "$ARTIFACTS/entry.log"
  kill "$MOCK_PID" 2>/dev/null || true
  exit 10
fi

dsh --profile web --dump-config > "$ARTIFACTS/dump-config.txt" 2>&1 || true
if ! grep -q "name: '@catwithoutear/dsh-prompt-assist'" "$ARTIFACTS/dump-config.txt"; then
  echo "plugin bundle row missing from dump-config" >> "$ARTIFACTS/entry.log"
  kill "$MOCK_PID" 2>/dev/null || true
  exit 12
fi

dsh --profile web --port "$WEB_PORT" --no-open > "$ARTIFACTS/dsh-web.log" 2>&1 &
DSH_PID=$!

URL=""
for _ in $(seq 1 180); do
  URL=$(grep -o 'dsh web: http[^ ]*' "$ARTIFACTS/dsh-web.log" 2>/dev/null | head -1 | sed 's/^dsh web: //' || true)
  [ -n "$URL" ] && break
  sleep 1
done

if [ -z "$URL" ]; then
  echo "dsh web did not announce a URL" >> "$ARTIFACTS/entry.log"
  tail -80 "$ARTIFACTS/dsh-web.log" >> "$ARTIFACTS/entry.log"
  kill "$MOCK_PID" "$DSH_PID" 2>/dev/null || true
  exit 11
fi

echo "dsh web url: $URL" >> "$ARTIFACTS/entry.log"
echo "$URL" > "$ARTIFACTS/dsh-url.txt"

set +e
cd /verify
DSH_URL="$URL" npx playwright test --config playwright.config.mjs > "$ARTIFACTS/playwright.log" 2>&1
RC=$?
set -e
echo "playwright exit: $RC" >> "$ARTIFACTS/entry.log"

curl -fsS "http://127.0.0.1:${MOCK_PORT}/__stats" > "$ARTIFACTS/llm-stats.json" 2>/dev/null || true
tail -80 "$ARTIFACTS/playwright.log" >> "$ARTIFACTS/entry.log"

install -m 0644 "$DSH_HOME/settings.yaml.imported" "$ARTIFACTS/settings-imported.yaml" 2>/dev/null || true
install -m 0644 "$DSH_HOME/profiles/web/package.json" "$ARTIFACTS/profile-package.json" 2>/dev/null || true
install -m 0644 "$DSH_HOME/profiles/web/cordis.patch.yml" "$ARTIFACTS/profile-cordis.patch.yml" 2>/dev/null || true

kill "$DSH_PID" "$MOCK_PID" 2>/dev/null || true
wait "$DSH_PID" 2>/dev/null || true
wait "$MOCK_PID" 2>/dev/null || true
exit "$RC"
