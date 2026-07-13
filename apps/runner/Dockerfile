# Runner image (doc 01 §2): one process, one job, exit.
# Build context = repo root:  docker build -f apps/runner/Dockerfile .
FROM mcr.microsoft.com/playwright:v1.61.1-jammy AS base

RUN corepack enable && corepack prepare pnpm@10.12.4 --activate
WORKDIR /repo

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/runner ./apps/runner

# build the runner and every workspace package it depends on
# (db + inference were added after this file was first written — never
# enumerate packages by hand, the `...` filter tracks the dependency graph)
RUN pnpm install --frozen-lockfile --filter @flowguard/runner... \
  && pnpm --filter @flowguard/runner... build \
  # browsers live in the base image (/ms-playwright); dev deps are dead weight
  && pnpm prune --prod \
  && pnpm store prune && rm -rf /root/.cache /root/.local/share/pnpm/store
# Image size (~3.9GB) is dominated by the Playwright base layers (all three
# browsers + OS). v1 only runs chromium; if pull time ever matters, rebase on
# node:22-slim + `playwright install --with-deps chromium` (~1.5GB).

WORKDIR /repo/apps/runner
ENV NODE_ENV=production
# worker mode by default; `node dist/cli.js <spec> <url>` for one-shot runs
CMD ["node", "dist/worker.js"]
