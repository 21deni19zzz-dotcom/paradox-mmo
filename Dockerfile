# ===========================================================================
# Paradox MMO - all-in-one Railway image (Kaetram-Open fork).
#
# Single service:
#   1. Build server (Node + uWS + TypeScript)
#   2. Build client (Astro SSG). CLIENT_REMOTE_HOST is baked into the HTML —
#      for production we point it to the same Railway domain the server
#      exposes, and the server serves the static files from `/client-dist`
#      via the patched `httpResponse` in `packages/server/src/network/websocket.ts`.
#
# Build args (Railway: service → Settings → Build → Build Args):
#   CLIENT_REMOTE_HOST   your-app.up.railway.app     (no protocol, no port)
#   CLIENT_REMOTE_PORT   443
#   SSL                  true
#   NAME                 Paradox
# ===========================================================================
FROM node:20-slim AS builder

RUN apt-get update && apt-get install -y \
    git python3 build-essential ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /app

# Monorepo plumbing
COPY package.json yarn.lock tsconfig.json ./
COPY .yarnrc.yml* ./
COPY .yarn ./.yarn
COPY .env.defaults ./

COPY packages/common  ./packages/common
COPY packages/server  ./packages/server
COPY packages/client  ./packages/client
COPY packages/tools   ./packages/tools

# Install all deps including native modules (sharp, uws).
# --mode=skip-build would break Sharp native binding on linux-x64.
# supportedArchitectures in .yarnrc overrides would be cleaner, but this CI hint works.
ENV npm_config_arch=x64
ENV npm_config_platform=linux
ENV npm_config_libc=glibc
RUN yarn install

# ---- server build ----
ARG MAX_PLAYERS=50
ENV ACCEPT_LICENSE=true
ENV SKIP_DATABASE=true
ENV MAX_PLAYERS=${MAX_PLAYERS}
RUN yarn workspace @kaetram/server build

# ---- client build ----
# Astro is SSG so these MUST be set at build time.
ARG CLIENT_REMOTE_HOST=localhost
ARG CLIENT_REMOTE_PORT=9001
ARG SSL=false
ARG NAME=Paradox

ENV CLIENT_REMOTE_HOST=${CLIENT_REMOTE_HOST}
ENV CLIENT_REMOTE_PORT=${CLIENT_REMOTE_PORT}
ENV HOST=${CLIENT_REMOTE_HOST}
ENV PORT=${CLIENT_REMOTE_PORT}
ENV SSL=${SSL}
ENV NAME=${NAME}

RUN yarn workspace @kaetram/client build

# ===========================================================================
FROM node:20-slim AS runtime

RUN apt-get update && apt-get install -y ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Server artefacts + node_modules (contains uws native binding)
COPY --from=builder /app/packages/server/dist       ./packages/server/dist
COPY --from=builder /app/packages/server/data       ./packages/server/data
COPY --from=builder /app/packages/server/package.json ./packages/server/package.json
COPY --from=builder /app/packages                    ./packages
COPY --from=builder /app/node_modules                ./node_modules
COPY --from=builder /app/.env.defaults               ./
COPY --from=builder /app/package.json                ./

# Client static bundle — the patched httpResponse looks here
COPY --from=builder /app/packages/client/dist ./client-dist

# Entrypoint generates .env from Railway-injected process env
# (Kaetram's dotenv-extended doesn't read process.env directly)
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

ENV NODE_ENV=production
ENV ACCEPT_LICENSE=true
ENV SKIP_DATABASE=true
ENV DATABASE=mongodb
ENV HOST=0.0.0.0
ENV MAX_PLAYERS=50
ENV TUTORIAL_ENABLED=false
ENV OVERWRITE_AUTH=true

# Railway injects $PORT at runtime; Kaetram's dotenv will pick it up.
EXPOSE 9001

CMD ["/app/docker-entrypoint.sh"]
