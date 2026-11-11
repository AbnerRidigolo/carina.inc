/**
 * Fixa a regra do ESLint que restringe o cliente Prisma bruto (sem RLS) a core/database,
 * modules/tenancy e aos testes. Roda o ESLint de verdade, com o eslint.config.js da raiz, sobre
 * caminhos fictícios (os arquivos não precisam existir).
 */
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
const RULES = new Set(["@typescript-eslint/no-restricted-imports", "no-restricted-syntax"]);

let eslint: ESLint;

async function restrictionErrors(file: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: `${repoRoot}apps/api/${file}` });
  if (!result) throw new Error("ESLint não devolveu resultado");
  const fatal = result.messages.filter((m) => m.fatal);
  if (fatal.length > 0) throw new Error(fatal.map((m) => m.message).join("; "));
  return result.messages.filter((m) => m.ruleId && RULES.has(m.ruleId)).map((m) => m.message);
}

const staticImport = (path: string) =>
  `import { PrismaService } from "${path}";\nexport const x = PrismaService;\n`;

describe("ESLint: PrismaService/PrismaClient restritos", () => {
  beforeAll(() => {
    eslint = new ESLint({ cwd: repoRoot });
  });

  describe("bloqueia fora de core/database, modules/tenancy e test", () => {
    const blocked: [string, string, string][] = [
      [
        "import relativo de src/core/foo",
        "src/core/foo/x.ts",
        staticImport("../database/prisma.service.js"),
      ],
      [
        "import sem extensão de src/core/foo",
        "src/core/foo/x.ts",
        staticImport("../database/prisma.service"),
      ],
      [
        "import relativo de src/modules/foo",
        "src/modules/foo/x.ts",
        staticImport("../../core/database/prisma.service.js"),
      ],
      [
        "import relativo de src/ (raiz)",
        "src/x.ts",
        staticImport("./core/database/prisma.service.js"),
      ],
      [
        "re-export",
        "src/core/foo/x.ts",
        `export { PrismaService } from "../database/prisma.service.js";\n`,
      ],
      [
        "PrismaClient de @prisma/client",
        "src/modules/foo/x.ts",
        `import { PrismaClient } from "@prisma/client";\nexport const x = PrismaClient;\n`,
      ],
      [
        "namespace de @prisma/client",
        "src/modules/foo/x.ts",
        `import * as P from "@prisma/client";\nexport const x = P;\n`,
      ],
      [
        "PrismaClient do cliente gerado",
        "src/core/foo/x.ts",
        `import { PrismaClient } from "../../generated/prisma/client.js";\nexport const x = PrismaClient;\n`,
      ],
      [
        "import() dinâmico do PrismaService",
        "src/core/foo/x.ts",
        `export const load = () => import("../database/prisma.service.js");\n`,
      ],
      [
        "import() dinâmico com template literal",
        "src/core/foo/x.ts",
        "export const load = () => import(`../database/prisma.service.js`);\n",
      ],
      [
        "require() do PrismaService",
        "src/core/foo/x.ts",
        `declare const require: (id: string) => unknown;\nexport const x = require("../database/prisma.service.js");\n`,
      ],
      [
        "import() dinâmico de @prisma/client",
        "src/modules/foo/x.ts",
        `export const load = () => import("@prisma/client");\n`,
      ],
      [
        "import() dinâmico do cliente gerado",
        "src/modules/foo/x.ts",
        `export const load = () => import("../../generated/prisma/client.js");\n`,
      ],
    ];
    it.each(blocked)("%s", async (_name, file, code) => {
      expect(await restrictionErrors(file, code)).not.toEqual([]);
    });
  });

  describe("permite nos lugares autorizados e o que é seguro", () => {
    const allowed: [string, string, string][] = [
      ["src/core/database", "src/core/database/x.ts", staticImport("./prisma.service.js")],
      [
        "src/modules/tenancy",
        "src/modules/tenancy/x.ts",
        staticImport("../../core/database/prisma.service.js"),
      ],
      ["test/", "test/x.ts", staticImport("../src/core/database/prisma.service.js")],
      [
        "import() dinâmico em tenancy",
        "src/modules/tenancy/x.ts",
        `export const load = () => import("../../core/database/prisma.service.js");\n`,
      ],
      [
        "TenantPrismaService em qualquer lugar",
        "src/core/foo/x.ts",
        `import { TenantPrismaService } from "../database/tenant-prisma.service.js";\nexport const x = TenantPrismaService;\n`,
      ],
      [
        "import de tipo do PrismaClient",
        "src/modules/foo/x.ts",
        `import type { PrismaClient } from "../../generated/prisma/client.js";\nexport type X = PrismaClient;\n`,
      ],
      [
        "namespace Prisma do cliente gerado",
        "src/modules/foo/x.ts",
        `import { Prisma } from "../../generated/prisma/client.js";\nexport const x = Prisma;\n`,
      ],
    ];
    it.each(allowed)("%s", async (_name, file, code) => {
      expect(await restrictionErrors(file, code)).toEqual([]);
    });
  });
}, 60_000);
