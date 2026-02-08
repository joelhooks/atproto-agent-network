#!/usr/bin/env bash
set -euo pipefail

# Teardown script for atproto-agent-network Cloudflare resources.
#
# ⚠️  DESTRUCTIVE — this deletes all provisioned resources!
#
# Usage:
#   ./scripts/teardown.sh [--confirm] [--keep-d1]
#
# Without --confirm, runs in dry-run mode (shows what would be deleted).
#
# Auth:
#   secrets exec --namespace atproto-agents -- ./scripts/teardown.sh --confirm

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
WRANGLER_CONFIG="${REPO_ROOT}/apps/network/wrangler.toml"

D1_NAME="${D1_NAME:-agent-records}"
R2_BUCKET="${R2_BUCKET:-agent-blobs}"
VECTORIZE_INDEX="${VECTORIZE_INDEX:-agent-memory}"
QUEUE_NAME="${QUEUE_NAME:-agent-messages}"
WORKER_NAME="${WORKER_NAME:-agent-network}"

CONFIRM=0
KEEP_D1=0

usage() {
  cat <<'EOF'
Usage:
  ./scripts/teardown.sh [--confirm] [--keep-d1]

Flags:
  --confirm    Actually delete resources (default: dry-run)
  --keep-d1    Keep the D1 database (preserves data)

What it deletes:
  1) Worker deployment (agent-network)
  2) Worker secrets (OPENROUTER_API_KEY, ADMIN_TOKEN, CF_ACCOUNT_ID)
  3) D1 database (agent-records) — unless --keep-d1
  4) R2 bucket (agent-blobs) — if it exists
  5) Vectorize index (agent-memory) — if it exists
  6) Queue (agent-messages) — if it exists
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

while [ "${1:-}" != "" ]; do
  case "$1" in
    --confirm)
      CONFIRM=1
      shift
      ;;
    --keep-d1)
      KEEP_D1=1
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

need_cmd wrangler

if [ "$CONFIRM" -eq 0 ]; then
  printf '🔍 DRY RUN — showing what would be deleted. Pass --confirm to actually delete.\n\n'
fi

step "Delete Worker: ${WORKER_NAME}"
if [ "$CONFIRM" -eq 1 ]; then
  wrangler delete --name "$WORKER_NAME" --force 2>&1 || printf 'Worker not found or already deleted.\n'
else
  printf '  Would delete worker: %s\n' "$WORKER_NAME"
fi

step "Delete D1 database: ${D1_NAME}"
if [ "$KEEP_D1" -eq 1 ]; then
  printf '  Skipping (--keep-d1 flag set)\n'
else
  if [ "$CONFIRM" -eq 1 ]; then
    # Get D1 ID
    D1_ID=""
    if command -v jq >/dev/null 2>&1; then
      D1_ID="$(wrangler d1 list --json 2>/dev/null | jq -r --arg name "$D1_NAME" '.[] | select(.name == $name) | .uuid' | head -n 1 || true)"
    fi
    if [ -n "$D1_ID" ]; then
      wrangler d1 delete "$D1_ID" --skip-confirmation 2>&1 || printf 'D1 delete failed.\n'
    else
      printf 'D1 database not found.\n'
    fi
  else
    printf '  Would delete D1 database: %s\n' "$D1_NAME"
  fi
fi

step "Delete R2 bucket: ${R2_BUCKET}"
if [ "$CONFIRM" -eq 1 ]; then
  wrangler r2 bucket delete "$R2_BUCKET" 2>&1 || printf 'R2 bucket not found or already deleted.\n'
else
  printf '  Would delete R2 bucket: %s\n' "$R2_BUCKET"
fi

step "Delete Vectorize index: ${VECTORIZE_INDEX}"
if [ "$CONFIRM" -eq 1 ]; then
  wrangler vectorize delete "$VECTORIZE_INDEX" --force 2>&1 || printf 'Vectorize index not found or already deleted.\n'
else
  printf '  Would delete Vectorize index: %s\n' "$VECTORIZE_INDEX"
fi

step "Delete Queue: ${QUEUE_NAME}"
if [ "$CONFIRM" -eq 1 ]; then
  wrangler queues delete "$QUEUE_NAME" 2>&1 || printf 'Queue not found or already deleted.\n'
else
  printf '  Would delete Queue: %s\n' "$QUEUE_NAME"
fi

if [ "$CONFIRM" -eq 1 ]; then
  step "Done! All resources deleted."
  printf '\nTo re-provision: ./scripts/deploy.sh\n'
else
  step "Dry run complete."
  printf '\nTo actually delete: ./scripts/teardown.sh --confirm\n'
  printf 'To keep the database: ./scripts/teardown.sh --confirm --keep-d1\n'
fi
