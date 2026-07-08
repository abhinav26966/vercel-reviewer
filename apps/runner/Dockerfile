# Runner image (doc 01 §2): one process, one job, exit.
# Build context = repo root:  docker build -f apps/runner/Dockerfile .
FROM mcr.microsoft.com/playwright:v1.61.1-jammy AS base

RUN corepack enable && corepack prepare pnpm@10.12.4 --activate
WORKDIR /repo

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/runner ./apps/runner

RUN pnpm install --frozen-lockfile --filter @flowguard/runner... \
  && pnpm --filter @flowguard/schemas build \
  && pnpm --filter @flowguard/shared build \
  && pnpm --filter @flowguard/runner build

WORKDIR /repo/apps/runner
ENV NODE_ENV=production
# worker mode by default; `node dist/cli.js <spec> <url>` for one-shot runs
CMD ["node", "dist/worker.js"]
