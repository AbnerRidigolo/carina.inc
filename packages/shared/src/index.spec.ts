import { describe, expect, it } from "vitest";
import { SHARED_VERSION } from "./index.js";

describe("shared", () => {
  it("exporta a versão do contrato", () => expect(SHARED_VERSION).toBe("1"));
});
