# Shipcast on a server (docs/server.md): the web app, whose process also runs the engine's rounds,
# behind a reverse proxy that does TLS (SHIPCAST_APP_TLS=proxy), with its secrets in an encrypted
# file (SHIPCAST_SECRET_STORE=file). Node runs the TypeScript sources directly, as on a desktop.
FROM node:24.22.1-trixie-slim

# git for the repos the engine clones; Chromium (Playwright's, with its system libraries) for the
# capture of screenshots and carousels. No docker and no tailscale: only the CLI's installer and the
# app's own TLS mode use them, and neither runs here.
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH PLAYWRIGHT_BROWSERS_PATH=/ms-playwright CI=1
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable

WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile \
    && pnpm --filter @shipcast/capture exec playwright-core install --with-deps chromium \
    && pnpm --filter @shipcast/web build \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /app/data /app/workspace \
    && chown -R node:node /app/data /app/workspace

USER node
ENV NODE_ENV=production SHIPCAST_APP_TLS=proxy SHIPCAST_APP_HOST=0.0.0.0 SHIPCAST_APP_PORT=8744 SHIPCAST_SECRET_STORE=file
EXPOSE 8744
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8744/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/main.ts"]
