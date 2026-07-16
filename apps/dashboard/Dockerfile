# Dashboard image. Build context = repo root:
#   docker build -f apps/dashboard/Dockerfile --build-arg NEXT_PUBLIC_API_URL=https://api.example.com .
# NEXT_PUBLIC_* is inlined at build time — rebuild if the api URL changes.
FROM node:22-slim AS build

RUN corepack enable && corepack prepare pnpm@10.12.4 --activate
WORKDIR /repo

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/dashboard ./apps/dashboard

ARG NEXT_PUBLIC_API_URL=http://localhost:8787
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL

RUN pnpm install --frozen-lockfile --filter @flowguard/dashboard... \
  && pnpm --filter @flowguard/dashboard... build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /repo/apps/dashboard/.next/standalone ./
COPY --from=build /repo/apps/dashboard/.next/static ./apps/dashboard/.next/static

EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0
CMD ["node", "apps/dashboard/server.js"]
