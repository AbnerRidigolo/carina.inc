# syntax=docker/dockerfile:1
#
# Imagem da API e do worker (mesma imagem, comandos diferentes). Build a partir da RAIZ do
# monorepo: `docker build -f apps/api/Dockerfile .` (o docker compose já faz isso).
#
# Estágios:
# - build:     todas as dependências (inclusive dev: o CLI `prisma`, de que o postinstall
#              `prisma generate` depende, e o TypeScript), cliente Prisma gerado, build do shared
#              e da API.
# - migrate:   o estágio de build com o CLI do Prisma e as migrações; roda `prisma migrate deploy`
#              como carina_migrator (MIGRATION_DATABASE_URL), o mesmo procedimento do harness de
#              testes. Usado pelo serviço `migrate` do compose.
# - prod-deps: só as dependências de produção (sem scripts de instalação).
# - runtime:   node + dependências de produção + dist; usuário sem privilégios (node), sem
#              segredos (tudo vem do ambiente em tempo de execução) e com HEALTHCHECK em /api/ready.
#
# Build e migrate usam a imagem Debian completa: ela já traz o OpenSSL que o schema engine do
# Prisma (`prisma migrate deploy`) detecta e carrega. O runtime usa a slim: o cliente Prisma 7 roda
# pelo driver adapter do pg, sem engine nativo.
ARG BUILD_IMAGE=node:22.22.2-bookworm
ARG NODE_IMAGE=node:22.22.2-bookworm-slim

FROM ${BUILD_IMAGE} AS base
# pnpm fixado na versão do packageManager (o corepack embutido no Node 22 pode não conferir as
# chaves novas de assinatura do pnpm).
RUN npm install -g pnpm@10.28.0 && npm cache clean --force
ENV CI=true
WORKDIR /repo

FROM base AS build
# Manifests primeiro (cache das dependências); o schema entra junto porque o postinstall da API
# roda `prisma generate`.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/prisma.config.ts apps/api/
COPY apps/api/prisma apps/api/prisma
RUN pnpm install --frozen-lockfile
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @carina/shared build && pnpm --filter @carina/api build

FROM build AS migrate
WORKDIR /repo/apps/api
ENV CHECKPOINT_DISABLE=1
USER node
CMD ["node_modules/.bin/prisma", "migrate", "deploy"]

FROM base AS prod-deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --filter "@carina/api..."

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production PORT=3000
WORKDIR /app
# Arquivos de root e só leitura para o processo (que roda como node).
COPY --from=prod-deps /repo/node_modules ./node_modules
COPY --from=prod-deps /repo/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=prod-deps /repo/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /repo/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /repo/packages/shared/dist ./packages/shared/dist
COPY --from=build /repo/apps/api/package.json ./apps/api/package.json
COPY --from=build /repo/apps/api/config ./apps/api/config
COPY --from=build /repo/apps/api/dist ./apps/api/dist
WORKDIR /app/apps/api
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
