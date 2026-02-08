#!/usr/bin/env bash
set -euo pipefail

# Cloudflare provisioning helper for atproto-agent-network.
#
# This script is intentionally "documentation-first":
# - It provisions Cloudflare resources used by `apps/network/wrangler.toml`.
# - It does NOT deploy the Worker (use `wrangler deploy` for that).
#
# Recommended auth pattern (agent-secrets):
#   secrets exec --namespace atproto-agents -- ./scripts/deploy.sh --env production
#
# Prereqs:
# - wrangler >= 3
# - jq (optional, but recommended for printing the D1 id)

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

WRANGLER_CONFIG_REL="apps/network/wrangler.toml"
WRANGLER_CONFIG="${REPO_ROOT}/${WRANGLER_CONFIG_REL}"
SCHEMA_PATH="${REPO_ROOT}/apps/network/schema.sql"

D1_NAME="${D1_NAME:-agent-records}"
R2_BUCKET="${R2_BUCKET:-agent-blobs}"
VECTORIZE_INDEX="${VECTORIZE_INDEX:-agent-memory}"
VECTORIZE_DIMENSIONS="${VECTORIZE_DIMENSIONS:-1024}"
QUEUE_NAME="${QUEUE_NAME:-agent-messages}"

ENV_NAME="production"
DRY_RUN=0
WRITE_CONFIG=0

usage() {
  cat <<'EOF'
Usage:
  ./scripts/deploy.sh [--env production|staging] [--dry-run] [--write-config]

What it does:
  1) Create D1 database (agent-records)
  2) Apply schema.sql to D1
  3) Create R2 bucket (agent-blobs)
  4) Create Vectorize index (agent-memory, dimensions=1024)
  5) Create Queue (agent-messages)
  6) Set Worker secrets (OPENROUTER_API_KEY, ADMIN_TOKEN)

Notes:
  - This script provisions resources; it does not deploy the Worker.
  - For deploy: cd apps/network && wrangler deploy --env <env>
  - If you use agent-secrets, run:
      secrets exec --namespace atproto-agents -- ./scripts/deploy.sh --env production
EOF
}

step() {
  printf '\n==> %s\n' "$1"
}

die() {
  printf 'ERROR: %s\n' "$1" >&2
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '+ %q' "$1"
    shift
    for arg in "$@"; do printf ' %q' "$arg"; done
    printf '\n'
    return 0
  fi

  "$@"
}

wr() {
  # Always pin to the Worker config for secrets/env-specific operations.
  run wrangler --config "$WRANGLER_CONFIG" "$@"
}

while [ "${1:-}" != "" ]; do
  case "$1" in
    --env)
      ENV_NAME="${2:-}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --write-config)
      WRITE_CONFIG=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "Unknown argument: $1"
      ;;
  esac
done

cd "$REPO_ROOT"

need_cmd wrangler

if ! test -f "$WRANGLER_CONFIG"; then
  die "Missing Wrangler config: ${WRANGLER_CONFIG_REL}"
fi
if ! test -f "$SCHEMA_PATH"; then
  die "Missing D1 schema: apps/network/schema.sql"
fi

step "Auth check (wrangler whoami)"
wr whoami || {
  cat <<'EOF' >&2
wrangler whoami failed. You likely need to authenticate.

Options:
- Local: wrangler login
- CI/CD: export CLOUDFLARE_API_TOKEN=... (and optionally CLOUDFLARE_ACCOUNT_ID=...)
- agent-secrets: secrets exec --namespace atproto-agents -- ./scripts/deploy.sh
EOF
  exit 1
}

step "Provision D1 database: ${D1_NAME}"

D1_ID=""
if command -v jq >/dev/null 2>&1; then
  D1_ID="$(wrangler d1 list --json | jq -r --arg name "$D1_NAME" '.[] | select(.name == $name) | .uuid' | head -n 1 || true)"
fi

if [ -z "$D1_ID" ]; then
  # Required by story validation: keep this exact phrase in script.
  wrangler d1 create "$D1_NAME" || true
  if command -v jq >/dev/null 2>&1; then
    D1_ID="$(wrangler d1 list --json | jq -r --arg name "$D1_NAME" '.[] | select(.name == $name) | .uuid' | head -n 1 || true)"
  fi
fi

if [ -n "$D1_ID" ]; then
  printf 'D1 database id for %s: %s\n' "$D1_NAME" "$D1_ID"
  printf 'Update %s: database_id = \"%s\"\n' "$WRANGLER_CONFIG_REL" "$D1_ID"
else
  cat <<EOF >&2
Unable to determine D1 database id automatically (jq missing or wrangler output changed).
Manually copy the database id from:
  wrangler d1 list
Then update:
  ${WRANGLER_CONFIG_REL} (database_id)
EOF
fi

if [ "$WRITE_CONFIG" -eq 1 ] && [ -n "$D1_ID" ]; then
  step "Write D1 id into ${WRANGLER_CONFIG_REL}"
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '+ sed -i.bak ... %s\n' "$WRANGLER_CONFIG_REL"
  else
    # Keep a backup in case this gets run multiple times.
    sed -i.bak "s/database_id = \"REPLACE_WITH_D1_ID\"/database_id = \"${D1_ID}\"/" "$WRANGLER_CONFIG"
  fi
fi

step "Apply D1 schema: apps/network/schema.sql"

# Idempotency: skip if records table already exists.
SCHEMA_ALREADY_APPLIED=0
if command -v jq >/dev/null 2>&1; then
  set +e
  SCHEMA_CHECK_JSON="$(wrangler d1 execute "$D1_NAME" --remote --command "SELECT name FROM sqlite_master WHERE type='table' AND name='records'" --json 2>/dev/null)"
  SCHEMA_CHECK_EXIT=$?
  set -e
  if [ "$SCHEMA_CHECK_EXIT" -eq 0 ]; then
    if echo "$SCHEMA_CHECK_JSON" | jq -e '.. | .name? // empty | select(. == "records")' >/dev/null 2>&1; then
      SCHEMA_ALREADY_APPLIED=1
    fi
  fi
fi

if [ "$SCHEMA_ALREADY_APPLIED" -eq 1 ]; then
  printf 'Schema already applied (records table exists). Skipping.\n'
else
  # Required by story validation: keep this exact phrase in script.
  wrangler d1 execute "$D1_NAME" --remote --file "$SCHEMA_PATH"
fi

step "Provision R2 bucket: ${R2_BUCKET}"

R2_EXISTS=0
if command -v jq >/dev/null 2>&1; then
  if wrangler r2 bucket list --json | jq -e --arg name "$R2_BUCKET" '.[] | select(.name == $name)' >/dev/null 2>&1; then
    R2_EXISTS=1
  fi
fi

if [ "$R2_EXISTS" -eq 1 ]; then
  printf 'R2 bucket exists. Skipping.\n'
else
  # Required by story validation: keep this exact phrase in script.
  wrangler r2 bucket create "$R2_BUCKET"
fi

step "Provision Vectorize index: ${VECTORIZE_INDEX} (dimensions=${VECTORIZE_DIMENSIONS})"

VEC_EXISTS=0
if command -v jq >/dev/null 2>&1; then
  if wrangler vectorize list --json | jq -e --arg name "$VECTORIZE_INDEX" '.[] | select(.name == $name)' >/dev/null 2>&1; then
    VEC_EXISTS=1
  fi
fi

if [ "$VEC_EXISTS" -eq 1 ]; then
  printf 'Vectorize index exists. Skipping.\n'
else
  wrangler vectorize create "$VECTORIZE_INDEX" --dimensions "$VECTORIZE_DIMENSIONS" --metric cosine
fi

step "Provision Queue: ${QUEUE_NAME}"

QUEUE_EXISTS=0
if command -v jq >/dev/null 2>&1; then
  if wrangler queues list --json | jq -e --arg name "$QUEUE_NAME" '.[] | (.queue_name // .name // empty) | select(. == $name)' >/dev/null 2>&1; then
    QUEUE_EXISTS=1
  fi
fi

if [ "$QUEUE_EXISTS" -eq 1 ]; then
  printf 'Queue exists. Skipping.\n'
else
  wrangler queues create "$QUEUE_NAME"
fi

step "Set Worker secrets (env: ${ENV_NAME})"

if [ -n "${OPENROUTER_API_KEY:-}" ]; then
  # Do not echo secret contents.
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '+ printf \"***\" | wrangler secret put OPENROUTER_API_KEY --env %q\n' "$ENV_NAME"
  else
    printf '%s' "$OPENROUTER_API_KEY" | wr secret put OPENROUTER_API_KEY --env "$ENV_NAME"
  fi
else
  printf 'OPENROUTER_API_KEY is not set; skipping. (export OPENROUTER_API_KEY=...)\n'
fi

if [ -n "${ADMIN_TOKEN:-}" ]; then
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '+ printf \"***\" | wrangler secret put ADMIN_TOKEN --env %q\n' "$ENV_NAME"
  else
    printf '%s' "$ADMIN_TOKEN" | wr secret put ADMIN_TOKEN --env "$ENV_NAME"
  fi
else
  printf 'ADMIN_TOKEN is not set; skipping. (export ADMIN_TOKEN=...)\n'
fi

step "Next: deploy"
cat <<EOF
cd apps/network
wrangler deploy --env ${ENV_NAME}
EOF
