# Zyrox server + dashboard in one image.
#   docker build -t zyrox .
#   docker run -p 4400:4400 -e DATABASE_URL=postgres://… zyrox
# Without DATABASE_URL it uses an embedded PGlite database in /data (mount a volume).

FROM node:22-slim AS build
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --filter "@wishyor/zyrox-dashboard..." --filter "@wishyor/zyrox-server..."
RUN pnpm --filter @wishyor/zyrox-dashboard build

FROM node:22-slim
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
RUN pnpm install --prod --frozen-lockfile --filter "@wishyor/zyrox-server..." && rm -rf /root/.cache /root/.local/share/pnpm
COPY --from=build /app/apps/dashboard/dist ./apps/dashboard/dist
ENV PORT=4400 \
    DATABASE_URL=/data \
    ZYROX_DASHBOARD_DIR=/app/apps/dashboard/dist
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 4400
USER node
CMD ["packages/server/node_modules/.bin/tsx", "packages/server/src/main.ts"]
