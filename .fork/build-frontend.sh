#!/usr/bin/env bash
# Build the production frontend bundle into frontend/build.
# Same-origin API, no analytics/telemetry SDKs (runtime settings are injected
# by the SigNoz server into index.html anyway).
set -euo pipefail
cd "$(dirname "$0")/../frontend"

cat > .env <<'EOF'
NODE_ENV="production"
BUNDLE_ANALYSER="false"
CI="1"
VITE_BASE_PATH=""
VITE_FRONTEND_API_ENDPOINT=""
VITE_WEBSOCKET_API_ENDPOINT=""
VITE_PYLON_ENABLED="false"
VITE_APPCUES_ENABLED="false"
VITE_POSTHOG_ENABLED="false"
VITE_SENTRY_ENABLED="false"
VITE_DOCS_BASE_URL="https://signoz.io"
VITE_ENVIRONMENT="production"
EOF
echo "VITE_VERSION=\"$(cat ../.fork/base)\"" >> .env

pnpm install --frozen-lockfile
NODE_OPTIONS=--max-old-space-size=8192 pnpm build
