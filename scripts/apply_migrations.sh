#!/usr/bin/env bash
# Apply pending database migrations.
# Loads .env when running locally; on Railway the env vars are injected.
set -euo pipefail

cd "$(dirname "$0")/.."

# Load local .env if present so DATABASE_URL is available during local runs.
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

npm run db:migrate
