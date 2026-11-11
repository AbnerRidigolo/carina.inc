import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { conditions: ["source"] },
  ssr: { resolve: { conditions: ["source"] } },
  test: {
    projects: [
      { extends: true, test: { name: "unit", include: ["src/**/*.spec.ts"] } },
      { extends: true, test: { name: "int", include: ["src/**/*.int-spec.ts"] } },
      { extends: true, test: { name: "e2e", include: ["src/**/*.e2e-spec.ts"] } },
    ],
  },
});
