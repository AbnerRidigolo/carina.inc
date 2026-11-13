import { defineConfig } from "vitest/config";

// Integração e E2E compartilham o global-setup (Postgres com migrações + Redis).
const dbProject = { globalSetup: ["test/setup/global-setup.ts"], testTimeout: 30_000 };

// `groupOrder`: numa execução com vários projetos (ex.: `test:cov`), unit → int → e2e rodam em
// sequência, nunca ao mesmo tempo. Os DBs lógicos do Redis são únicos só dentro de cada projeto
// (test/setup/redis-dbs.ts).
export default defineConfig({
  resolve: { conditions: ["source"] },
  ssr: { resolve: { conditions: ["source"] } },
  test: {
    projects: [
      {
        extends: true,
        test: { name: "unit", include: ["src/**/*.spec.ts"], sequence: { groupOrder: 0 } },
      },
      {
        extends: true,
        test: {
          name: "int",
          include: ["test/**/*.int.spec.ts"],
          sequence: { groupOrder: 1 },
          ...dbProject,
        },
      },
      {
        extends: true,
        test: {
          name: "e2e",
          include: ["test/**/*.e2e.spec.ts"],
          sequence: { groupOrder: 2 },
          ...dbProject,
        },
      },
    ],
  },
});
