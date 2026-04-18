#!/bin/sh
# Kaetram uses dotenv-extended with includeProcessEnv=false by default,
# which means Railway's injected env vars are IGNORED unless they're in a .env file.
# This script materialises process.env -> .env before starting the server.

set -e

ENV_FILE="/app/.env"

# Whitelist of vars Kaetram's config recognises. Generated from .env.defaults.
VARS="NAME HOST PORT SSL API_ENABLED API_PORT SERVER_ID ACCESS_TOKEN \
  HUB_ENABLED HUB_HOST HUB_WS_HOST HUB_PORT HUB_WS_PORT REMOTE_SERVER_HOST \
  REMOTE_API_HOST HUB_ACCESS_TOKEN ADMIN_HOST ADMIN_PORT \
  CLIENT_REMOTE_HOST CLIENT_REMOTE_PORT \
  CLEANUP_THRESHOLD CLEANUP_TIME \
  SKIP_DATABASE DATABASE \
  MONGODB_HOST MONGODB_PORT MONGODB_USER MONGODB_PASSWORD MONGODB_DATABASE \
  MONGODB_TLS MONGODB_SRV MONGODB_AUTH_SOURCE \
  AGGREGATE_THRESHOLD \
  TUTORIAL_ENABLED OVERWRITE_AUTH DISABLE_REGISTER MAX_PLAYERS UPDATE_TIME \
  GVER MINOR REGION_CACHE SAVE_INTERVAL MESSAGE_LIMIT \
  SMTP_HOST SMTP_PORT SMTP_USE_SECURE SMTP_USER SMTP_PASSWORD \
  SENTRY_ORG SENTRY_PROJECT SENTRY_AUTH_TOKEN SENTRY_DSN \
  STRIPE_ENDPOINT STRIPE_KEY_LOCAL STRIPE_SECRET_KEY \
  DISCORD_ENABLED DISCORD_CHANNEL_ID DISCORD_BOT_TOKEN \
  ACCEPT_LICENSE \
  DEBUGGING DEBUG_LEVEL FS_DEBUGGING"

# Truncate
: > "$ENV_FILE"

for v in $VARS; do
  # Use eval to get the value of the variable by name
  eval "val=\${$v}"
  if [ -n "$val" ]; then
    # Quote the value to be safe with spaces / special chars
    # Escape any single quotes in the value
    escaped=$(printf '%s' "$val" | sed "s/'/'\\\\''/g")
    printf "%s='%s'\n" "$v" "$escaped" >> "$ENV_FILE"
  fi
done

# Railway injects PORT at runtime. If PORT env var was set by Railway but wasn't
# in our whitelist loop above (it always is, but belt-and-braces), make sure it
# makes it into the file too, and use it for HOST binding.
if [ -n "$PORT" ] && ! grep -q "^PORT=" "$ENV_FILE"; then
  printf "PORT=%s\n" "$PORT" >> "$ENV_FILE"
fi

echo "[entrypoint] Wrote $(wc -l < $ENV_FILE) env vars to $ENV_FILE"
echo "[entrypoint] Server will bind to ${HOST:-0.0.0.0}:${PORT:-9001}"

exec node --enable-source-maps packages/server/dist/main.js
