import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      { test: { name: "unit", include: ["src/**/*.spec.ts"] } },
      { test: { name: "int", include: ["src/**/*.int-spec.ts"] } },
      { test: { name: "e2e", include: ["src/**/*.e2e-spec.ts"] } },
    ],
  },
});
