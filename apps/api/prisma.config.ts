import { defineConfig } from "prisma/config";

// O CLI do Prisma só é usado para migrações, sempre com o papel dono (carina_migrator).
// A API conecta como carina_app pelo driver adapter (DATABASE_URL), não por aqui.
// Sem MIGRATION_DATABASE_URL (ex.: `prisma generate` no CI), o datasource fica de fora.
const migrationUrl = process.env["MIGRATION_DATABASE_URL"];
const shadowUrl = process.env["SHADOW_DATABASE_URL"];

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  ...(migrationUrl
    ? { datasource: { url: migrationUrl, ...(shadowUrl ? { shadowDatabaseUrl: shadowUrl } : {}) } }
    : {}),
});
