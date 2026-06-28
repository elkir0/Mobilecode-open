# SPDX-License-Identifier: Apache-2.0
# Minimal image for mobilecode-push-relay.
FROM node:20-slim

WORKDIR /app

# Install deps first for better layer caching.
COPY package*.json ./
RUN npm ci --omit=dev

# App source only (no .env, no data/, no config/*.p8 — those come from volumes).
COPY src ./src

# The runtime runs as the unprivileged `node` user.
USER node

# SQLite lives under /app/data (mounted volume). The .p8 key is mounted read-only
# under /app/config (see APNS_KEY_PATH in .env).
ENV NODE_ENV=production \
    DB_PATH=/app/data/relay.db \
    APNS_KEY_PATH=/app/config/AuthKey.p8

EXPOSE 3000
CMD ["node", "src/server.js"]
