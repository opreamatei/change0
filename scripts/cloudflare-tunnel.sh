#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PUBLIC_URL_FILE="$ROOT_DIR/.cloudflare-public-url"
LOG_FILE="${TMPDIR:-/tmp}/cloudflared-change2.log"
ORIGIN_URL="${ORIGIN_URL:-http://localhost:8085}"

cleanup() {
  rm -f "$PUBLIC_URL_FILE"
  if [[ -n "${CF_PID:-}" ]] && kill -0 "$CF_PID" 2>/dev/null; then
    kill "$CF_PID" 2>/dev/null || true
    wait "$CF_PID" 2>/dev/null || true
  fi
}

trap cleanup EXIT INT TERM

rm -f "$PUBLIC_URL_FILE" "$LOG_FILE"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared is not installed." >&2
  exit 1
fi

cloudflared tunnel --url "$ORIGIN_URL" --no-autoupdate >"$LOG_FILE" 2>&1 &
CF_PID=$!

public_url=""
for _ in $(seq 1 60); do
  if [[ -s "$LOG_FILE" ]]; then
    public_url="$(grep -Eo 'https://[-a-z0-9.]+trycloudflare\.com' "$LOG_FILE" | head -n 1 || true)"
    if [[ -n "$public_url" ]]; then
      break
    fi
  fi

  if ! kill -0 "$CF_PID" 2>/dev/null; then
    cat "$LOG_FILE" >&2
    exit 1
  fi

  sleep 1
done

if [[ -z "$public_url" ]]; then
  echo "Could not detect the public trycloudflare URL." >&2
  cat "$LOG_FILE" >&2
  exit 1
fi

printf '%s\n' "$public_url" > "$PUBLIC_URL_FILE"

echo "Public URL: $public_url"
echo "Tunnel target: $ORIGIN_URL"
echo "Public URL file: $PUBLIC_URL_FILE"
echo "Keep this process running while you test. Press Ctrl+C to stop the tunnel."

wait "$CF_PID"
