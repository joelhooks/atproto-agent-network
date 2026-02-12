#!/usr/bin/env bash
set -euo pipefail

# Post-deploy smoke test for atproto-agent-network.
#
# Validates the deployed Worker is reachable and healthy by calling:
#   GET /health
#   WS /firehose ping/pong (tokenless)
#
# Usage:
#   ./scripts/smoke-test.sh --url https://<worker-origin>
#   ./scripts/smoke-test.sh https://<worker-origin>
#
# Env vars:
#   SMOKE_TEST_URL            Same as --url
#   SMOKE_TEST_RETRIES        Default: 10
#   SMOKE_TEST_DELAY_SECONDS  Default: 2
#   SMOKE_TEST_TIMEOUT_SECONDS Default: 10
#
# Exit codes:
#   0 success
#   1 failure
#   2 usage error

usage() {
  cat <<'EOF'
Usage:
  ./scripts/smoke-test.sh --url https://<worker-origin>
  ./scripts/smoke-test.sh https://<worker-origin>

Examples:
  ./scripts/smoke-test.sh https://agent-network.<subdomain>.workers.dev
  SMOKE_TEST_URL=https://agent-network.<subdomain>.workers.dev ./scripts/smoke-test.sh

What it checks:
  - GET /health returns HTTP 200
  - Response JSON includes: { "status": "ok", "missing": [], "uptimeMs": <number> }
  - WS /firehose accepts a connection and responds to {"type":"ping"} with {"type":"pong"}
EOF
}

die() {
  printf 'ERROR: %s\n' "$1" >&2
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

URL="${SMOKE_TEST_URL:-}"
RETRIES="${SMOKE_TEST_RETRIES:-10}"
DELAY_SECONDS="${SMOKE_TEST_DELAY_SECONDS:-2}"
TIMEOUT_SECONDS="${SMOKE_TEST_TIMEOUT_SECONDS:-10}"

while [ "${1:-}" != "" ]; do
  case "$1" in
    --url|--base-url|--health-url)
      URL="${2:-}"
      shift 2
      ;;
    --retries)
      RETRIES="${2:-}"
      shift 2
      ;;
    --delay-seconds)
      DELAY_SECONDS="${2:-}"
      shift 2
      ;;
    --timeout-seconds)
      TIMEOUT_SECONDS="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      if [ -z "$URL" ] && [[ "$1" != -* ]]; then
        URL="$1"
        shift
        continue
      fi
      die "Unknown argument: $1"
      ;;
  esac
done

if [ -z "$URL" ]; then
  usage >&2
  exit 2
fi

need_cmd curl
need_cmd node

# Normalize and build the health URL (the Worker exposes /health at the root).
URL="${URL%/}"
BASE_URL="$URL"
if [[ "$URL" == *"/health" ]]; then
  HEALTH_URL="$URL"
  BASE_URL="${URL%/health}"
else
  HEALTH_URL="${URL}/health"
fi

# WebSocket firehose URL.
WS_URL="${BASE_URL}"
WS_URL="${WS_URL/https:\/\//wss:\/\/}"
WS_URL="${WS_URL/http:\/\//ws:\/\/}"
WS_URL="${WS_URL%/}/firehose"

BODY_FILE="$(mktemp)"
trap 'rm -f "$BODY_FILE"' EXIT

validate_body() {
  if command -v node >/dev/null 2>&1; then
    node -e '
      const fs = require("fs");
      const raw = fs.readFileSync(process.argv[1], "utf8").trim();
      let data;
      try { data = JSON.parse(raw); } catch { process.exit(1); }
      if (data?.status !== "ok") process.exit(1);
      if (!Array.isArray(data?.missing) || data.missing.length !== 0) process.exit(1);
      if (typeof data?.uptimeMs !== "number") process.exit(1);
    ' "$BODY_FILE"
    return $?
  fi

  # Best-effort fallback without node/jq: validate minimal fields.
  grep -qE '"status"[[:space:]]*:[[:space:]]*"ok"' "$BODY_FILE" || return 1
  grep -qE '"missing"[[:space:]]*:[[:space:]]*\\[[[:space:]]*\\]' "$BODY_FILE" || return 1
  grep -qE '"uptimeMs"[[:space:]]*:[[:space:]]*[0-9]+' "$BODY_FILE" || return 1
  return 0
}

attempt=1
while [ "$attempt" -le "$RETRIES" ]; do
  printf 'Smoke test: GET %s (attempt %s/%s)\n' "$HEALTH_URL" "$attempt" "$RETRIES"

  http_code="000"
  curl_exit=0

  set +e
  http_code="$(curl -sS -m "$TIMEOUT_SECONDS" -o "$BODY_FILE" -w "%{http_code}" "$HEALTH_URL")"
  curl_exit=$?
  set -e

  if [ "$curl_exit" -eq 0 ] && [ "$http_code" = "200" ] && validate_body; then
    printf 'PASS: %s\n' "$HEALTH_URL"
    cat "$BODY_FILE"
    printf '\n'

    printf 'Smoke test: WS %s ping/pong\n' "$WS_URL"
    node -e '
      const url = process.argv[1];
      const timeoutMs = Number(process.argv[2] || "5000");
      if (typeof WebSocket !== "function") {
        console.error("Node WebSocket not available in this runtime");
        process.exit(1);
      }
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        console.error("WS timeout");
        try { ws.close(); } catch {}
        process.exit(1);
      }, timeoutMs);

      ws.addEventListener("open", () => {
        ws.send(JSON.stringify({ type: "ping" }));
      });

      ws.addEventListener("message", (evt) => {
        let data = evt.data;
        if (data && typeof data !== "string") data = String(data);
        try {
          const msg = JSON.parse(data);
          if (msg && msg.type === "pong") {
            clearTimeout(timer);
            try { ws.close(); } catch {}
            process.exit(0);
          }
        } catch {
          // ignore
        }
      });

      ws.addEventListener("error", () => {
        clearTimeout(timer);
        process.exit(1);
      });
    ' "$WS_URL" "$((TIMEOUT_SECONDS * 1000))"

    printf 'PASS: WS %s\n' "$WS_URL"
    exit 0
  fi

  if [ "$attempt" -eq "$RETRIES" ]; then
    printf 'FAIL: %s\n' "$HEALTH_URL" >&2
    printf 'HTTP status: %s (curl exit: %s)\n' "$http_code" "$curl_exit" >&2
    if test -s "$BODY_FILE"; then
      printf 'Body:\n' >&2
      cat "$BODY_FILE" >&2
      printf '\n' >&2
    fi
    exit 1
  fi

  attempt=$((attempt + 1))
  sleep "$DELAY_SECONDS"
done
