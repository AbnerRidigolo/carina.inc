import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Módulos do cliente Prisma bruto, para seletores esquery (sem "/" literal: o esquery não aceita
// barra escapada em regex). prisma.service, @prisma/client e o cliente gerado.
const PRISMA_MODULE_RE =
  "/(^|\\x2F)prisma\\.service(\\.[cm]?[jt]s)?$|^@prisma\\x2Fclient(\\x2F|$)|(^|\\x2F)generated\\x2Fprisma\\x2Fclient(\\.[cm]?[jt]s)?$/";

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
    // Os padrões casam pelo NOME do módulo (qualquer profundidade relativa), não por diretório.
    // Fixado por apps/api/src/core/database/prisma-import-restriction.spec.ts.
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
              group: ["**/prisma.service", "**/prisma.service.js", "**/prisma.service.ts"],
              message:
                "PrismaService (sem RLS) é restrito a core/database e modules/tenancy; use TenantPrismaService.",
            },
            {
              group: [
                "@prisma/client",
                "@prisma/client/*",
                "**/generated/prisma/client",
                "**/generated/prisma/client.js",
                "**/generated/prisma/client.ts",
              ],
              importNames: ["PrismaClient"],
              allowTypeImports: true,
              message: "Não instancie PrismaClient fora de core/database; use TenantPrismaService.",
            },
          ],
        },
      ],
      // import()/require() com caminho literal. Caminhos computados não são analisáveis
      // estaticamente (aceito: a revisão de código cobre).
      "no-restricted-syntax": [
        "error",
        {
          selector: `ImportExpression[source.value=${PRISMA_MODULE_RE}]`,
          message: "import() do cliente Prisma bruto é restrito a core/database e modules/tenancy.",
        },
        {
          selector: `ImportExpression[source.type="TemplateLiteral"][source.quasis.0.value.raw=${PRISMA_MODULE_RE}]`,
          message: "import() do cliente Prisma bruto é restrito a core/database e modules/tenancy.",
        },
        {
          selector: `CallExpression[callee.name="require"][arguments.0.value=${PRISMA_MODULE_RE}]`,
          message:
            "require() do cliente Prisma bruto é restrito a core/database e modules/tenancy.",
        },
      ],
    },
  },
);
