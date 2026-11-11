import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "legacy/**",
      "docs/**",
      ".claude/**",
      ".superpowers/**",
      // Cliente Prisma gerado (`prisma generate`)
      "**/src/generated/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    // Módulos NestJS são classes vazias decoradas com @Module.
    rules: { "@typescript-eslint/no-extraneous-class": ["error", { allowWithDecorator: true }] },
  },
  {
    // O cliente Prisma bruto (carina_app sem contexto de RLS) só pode ser usado pela camada de
    // banco e pela resolução de chaves de API (tenancy). O resto do código usa o
    // TenantPrismaService. Os testes (apps/api/test) preparam dados e testam o RLS com ele.
    files: ["apps/api/**/*.ts"],
    ignores: [
      "apps/api/src/core/database/**",
      "apps/api/src/modules/tenancy/**",
      "apps/api/test/**",
    ],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/core/database/prisma.service", "**/core/database/prisma.service.js"],
              message:
                "PrismaService (sem RLS) é restrito a core/database e modules/tenancy; use TenantPrismaService.",
            },
            {
              group: ["**/generated/prisma/client", "**/generated/prisma/client.js"],
              importNames: ["PrismaClient"],
              allowTypeImports: true,
              message: "Não instancie PrismaClient fora de core/database; use TenantPrismaService.",
            },
          ],
        },
      ],
    },
  },
);
