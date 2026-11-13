# syntax=docker/dockerfile:1
#
# Imagem do frontend: build do Vite (React) servido pelo nginx (nginx-unprivileged, porta 5173),
# que também faz proxy de `/api` (REST) e `/ws` (WebSocket do chat) para `api:3000`. Mesma origem
# no browser: sem CORS e a chave de API nunca vai para a URL.
# Build a partir da RAIZ do monorepo: `docker build -f apps/web/Dockerfile .`.
ARG NODE_IMAGE=node:22.22.2-bookworm-slim

FROM ${NODE_IMAGE} AS build
RUN npm install -g pnpm@10.28.0 && npm cache clean --force
ENV CI=true
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
# Sem scripts: o postinstall da API (prisma generate) não interessa ao frontend.
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN pnpm --filter @carina/shared build && pnpm --filter @carina/web build

FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 5173
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD wget -q -O /dev/null http://127.0.0.1:5173/ || exit 1
