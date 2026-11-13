# syntax=docker/dockerfile:1
#
# STUB da imagem do frontend: a Task 22 troca o conteúdo pelo build do Vite (React). Por ora
# compila o pacote @carina/web (prova que o build do workspace funciona na imagem) e serve uma
# página estática de espera na porta 5173, para o docker compose subir completo.
# Build a partir da RAIZ do monorepo: `docker build -f apps/web/Dockerfile .`.
ARG NODE_IMAGE=node:22.12.0-bookworm-slim

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
RUN mkdir -p /out && printf '%s\n' \
  '<!doctype html>' \
  '<html lang="pt-BR"><head><meta charset="utf-8"><title>CARINA</title></head>' \
  '<body><h1>CARINA</h1><p>Frontend em construção (Task 22). A API está em' \
  '<a href="http://localhost:3000/api/health">http://localhost:3000/api/health</a>.</p>' \
  '</body></html>' > /out/index.html

FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /out /usr/share/nginx/html
EXPOSE 5173
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD wget -q -O /dev/null http://127.0.0.1:5173/ || exit 1
