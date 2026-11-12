import { defineConfig } from "vitest/config";

// Integração e E2E compartilham o global-setup (Postgres com migrações + Redis).
const dbProject = { globalSetup: ["test/setup/global-setup.ts"], testTimeout: 30_000 };

export default defineConfig({
  resolve: { conditions: ["source"] },
  ssr: { resolve: { conditions: ["source"] } },
  test: {
    projects: [
      { extends: true, test: { name: "unit", include: ["src/**/*.spec.ts"] } },
      { extends: true, test: { name: "int", include: ["test/**/*.int.spec.ts"], ...dbProject } },
      { extends: true, test: { name: "e2e", include: ["test/**/*.e2e.spec.ts"], ...dbProject } },
    ],
  },
});
