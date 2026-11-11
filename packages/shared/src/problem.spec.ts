import { describe, expect, it } from "vitest";
import { ProblemSchema } from "./problem.js";

const problem = { type: "about:blank", title: "Not Found", status: 404, traceId: "t1" };

describe("ProblemSchema", () => {
  it("aceita sem detail", () => expect(ProblemSchema.safeParse(problem).success).toBe(true));
  it("aceita com detail", () =>
    expect(ProblemSchema.safeParse({ ...problem, detail: "x" }).success).toBe(true));
  it("exige traceId", () => {
    expect(ProblemSchema.safeParse({ type: "a", title: "b", status: 500 }).success).toBe(false);
  });
  it("exige status numérico", () => {
    expect(ProblemSchema.safeParse({ ...problem, status: "404" }).success).toBe(false);
  });
});
