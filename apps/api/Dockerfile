# API + orchestrator image (doc 01 §2). Build context = repo root:
#   docker build -f apps/api/Dockerfile .
FROM node:22-slim AS build

RUN corepack enable && corepack prepare pnpm@10.12.4 --activate
WORKDIR /repo

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api

# install + build the api and every workspace package it depends on
RUN pnpm install --frozen-lockfile --filter @flowguard/api... \
  && pnpm --filter @flowguard/api... build \
  # drop dev deps from the store-linked node_modules for the runtime image
  && pnpm prune --prod

FROM node:22-slim
WORKDIR /repo
COPY --from=build /repo ./

WORKDIR /repo/apps/api
ENV NODE_ENV=production
EXPOSE 8787
# migrations run as the Fly release_command (see infra/fly/fly.api.toml)
CMD ["node", "dist/server.js"]
